import { describe, expect, test } from "bun:test";

import { MAX_ROUNDS, QuestMachine, cutsceneLines, type QuestHooks, type QuestNode } from "./quests";

/**
 * The quest node machine.
 *
 * Conditions here are `{ flag: "name" }` objects resolved against a table, because what is under
 * test is the machine's control flow — what waits for the player, what re-enters safely, and what
 * stops instead of hanging — not the condition evaluator, which core already owns.
 */

interface Harness {
  machine: QuestMachine;
  events: string[];
  state: Record<string, unknown>;
}

function harness(
  graph: Record<string, QuestNode[]>,
  state: Record<string, unknown>,
  options: {
    conditions?: Record<string, boolean>;
    onEffects?: (effects: unknown[], context: { quest: string }) => void;
  } = {},
): Harness {
  const events: string[] = [];

  const hooks: QuestHooks = {
    nodes: (questId) => graph[questId] ?? [],
    evaluate: (condition) => {
      const flag = (condition as { flag?: string } | null)?.flag ?? "";
      return options.conditions?.[flag] === true;
    },
    applyEffects: (effects, context) => {
      events.push(`effects:${context.quest}`);
      options.onEffects?.(effects, context);
    },
    onUpdated: (questId, node) => void events.push(`updated:${questId}@${node}`),
    onCompleted: (questId) => void events.push(`completed:${questId}`),
    onCutscene: (questId, node) => void events.push(`cutscene:${questId}@${node}`),
    onWarning: (message) => void events.push(`warning:${message}`),
  };

  return { machine: new QuestMachine(state, hooks), events, state };
}

describe("advancing", () => {
  test("a passing complete_when moves the record to the next node", () => {
    const state: Record<string, unknown> = { ch01: { node: "n1" } };
    const graph = {
      ch01: [{ id: "n1", complete_when: { flag: "met" }, next: "n2" }, { id: "n2" }],
    };

    const { machine, events } = harness(graph, state, { conditions: { met: true } });
    machine.schedule();

    expect(state["ch01"]).toEqual({ node: "n2" });
    expect(events).toContain("updated:ch01@n2");
  });

  test("a node with no condition never advances — content must be explicit", () => {
    const state: Record<string, unknown> = { ch01: { node: "n1" } };
    const { machine } = harness({ ch01: [{ id: "n1", next: "n2" }, { id: "n2" }] }, state);

    machine.schedule();
    expect(state["ch01"]).toEqual({ node: "n1" });
  });

  test("an empty condition object counts as no condition", () => {
    const state: Record<string, unknown> = { ch01: { node: "n1" } };
    const { machine } = harness({ ch01: [{ id: "n1", complete_when: {}, next: "n2" }, { id: "n2" }] }, state);

    machine.schedule();
    expect(state["ch01"]).toEqual({ node: "n1" });
  });

  test("a terminal node marks the quest done and says so", () => {
    const state: Record<string, unknown> = { ch01: { node: "n1" } };
    const graph = { ch01: [{ id: "n1", complete_when: { flag: "met" }, next: null }] };

    const { machine, events } = harness(graph, state, { conditions: { met: true } });
    machine.schedule();

    expect(state["ch01"]).toEqual({ node: "n1", done: true });
    expect(events).toContain("completed:ch01");
  });

  test("an unknown node warns instead of throwing", () => {
    const state: Record<string, unknown> = { ch01: { node: "nowhere" } };
    const { machine, events } = harness({ ch01: [] }, state);

    machine.schedule();
    expect(events.some((event) => event.startsWith("warning:"))).toBe(true);
  });
});

describe("cutscenes", () => {
  test("a cutscene node waits for the player", () => {
    const state: Record<string, unknown> = { ch01: { node: "n1" } };
    const graph = {
      ch01: [
        { id: "n1", complete_when: { flag: "met" }, next: "n2" },
        { id: "n2", type: "cutscene", next: "n3" },
        { id: "n3" },
      ],
    };

    const { machine, events } = harness(graph, state, { conditions: { met: true } });
    machine.schedule();

    // The record moved *into* the cutscene and stopped there.
    expect(state["ch01"]).toEqual({ node: "n2" });
    expect(events).toContain("cutscene:ch01@n2");
    expect(machine.waitingOn).toEqual({ quest: "ch01", node: "n2" });

    // And nothing more happens until the player dismisses it.
    machine.schedule();
    expect(state["ch01"]).toEqual({ node: "n2" });
  });

  test("dismissing completes the cutscene node and moves on", () => {
    const state: Record<string, unknown> = { ch01: { node: "n1" } };
    const graph = {
      ch01: [
        { id: "n1", complete_when: { flag: "met" }, next: "n2" },
        { id: "n2", type: "cutscene", next: "n3", on_complete: [{ type: "flag" }] },
        { id: "n3" },
      ],
    };

    const { machine, events } = harness(graph, state, { conditions: { met: true } });
    machine.schedule();
    machine.dismissCutscene();

    expect(state["ch01"]).toEqual({ node: "n3" });
    expect(events).toContain("effects:ch01");
    expect(machine.waitingOn).toBeNull();
  });

  test("a cutscene that is not awaited dismissal is a no-op", () => {
    const state: Record<string, unknown> = { ch01: { node: "n1" } };
    const { machine } = harness({ ch01: [{ id: "n1" }] }, state);

    expect(() => machine.dismissCutscene()).not.toThrow();
    expect(state["ch01"]).toEqual({ node: "n1" });
  });

  test("lines come back as a list whether the node wrote one or many", () => {
    expect(cutsceneLines({ id: "n", text: { en: "one" } })).toEqual([{ en: "one" }]);
    expect(cutsceneLines({ id: "n", text: [{ en: "one" }, { en: "two" }] })).toEqual([
      { en: "one" },
      { en: "two" },
    ]);
    expect(cutsceneLines({ id: "n" })).toEqual([]);
  });
});

describe("on_complete effects", () => {
  test("run before the record is re-read, so an effect can stop the advance", () => {
    const state: Record<string, unknown> = { ch01: { node: "n1" } };
    const graph = {
      ch01: [{ id: "n1", complete_when: { flag: "met" }, next: "n2", on_complete: [{ type: "x" }] }, { id: "n2" }],
    };

    const { machine, events } = harness(graph, state, {
      conditions: { met: true },
      onEffects: () => {
        // A completion effect that finishes the quest outright: nothing may advance past it.
        (state["ch01"] as { done?: boolean }).done = true;
      },
    });
    machine.schedule();

    expect(state["ch01"]).toEqual({ node: "n1", done: true });
    expect(events.some((event) => event.startsWith("updated:"))).toBe(false);
  });

  test("a re-entrant schedule from an effect does not recurse or double-advance", () => {
    const state: Record<string, unknown> = { ch01: { node: "n1" } };
    const graph = {
      ch01: [{ id: "n1", complete_when: { flag: "met" }, next: "n2", on_complete: [{ type: "x" }] }, { id: "n2" }],
    };

    let calls = 0;
    const h = harness(graph, state, { conditions: { met: true } });
    const machine = new QuestMachine(state, {
      nodes: (questId) => graph[questId as keyof typeof graph] ?? [],
      evaluate: () => true,
      applyEffects: () => {
        calls += 1;
        machine.schedule(); // the effect changes state, which normally schedules a pass
      },
    });

    machine.schedule();
    expect(calls).toBe(1);
    expect(state["ch01"]).toEqual({ node: "n2" });
    void h;
  });

  test("a cyclic graph stops with a warning instead of hanging", () => {
    const state: Record<string, unknown> = { loop: { node: "a" } };
    const graph = {
      loop: [
        { id: "a", complete_when: { flag: "go" }, next: "b" },
        { id: "b", complete_when: { flag: "go" }, next: "a" },
      ],
    };

    const { machine, events } = harness(graph, state, { conditions: { go: true } });

    // The assertion is that this returns at all.
    machine.schedule();
    expect(events.some((event) => event.includes(`hit ${MAX_ROUNDS} rounds`))).toBe(true);
    expect(state["loop"]).toBeDefined();
  });
});

describe("several quests", () => {
  test("each advances independently in one pass", () => {
    const state: Record<string, unknown> = { a: { node: "n1" }, b: { node: "n1" } };
    const graph = {
      a: [{ id: "n1", complete_when: { flag: "go" }, next: "n2" }, { id: "n2" }],
      b: [{ id: "n1", complete_when: { flag: "go" }, next: "n2" }, { id: "n2" }],
    };

    const { machine } = harness(graph, state, { conditions: { go: true } });
    machine.schedule();

    expect(state["a"]).toEqual({ node: "n2" });
    expect(state["b"]).toEqual({ node: "n2" });
  });

  test("a done quest is left alone", () => {
    const state: Record<string, unknown> = { a: { node: "n1", done: true } };
    const graph = { a: [{ id: "n1", complete_when: { flag: "go" }, next: "n2" }] };

    const { machine, events } = harness(graph, state, { conditions: { go: true } });
    machine.schedule();

    expect(state["a"]).toEqual({ node: "n1", done: true });
    expect(events).toHaveLength(0);
  });
});
