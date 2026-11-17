/* Condition builder (PLAN 9.2) — rule rows that emit §5.5 JSON, with a live evaluator.
 *
 * The §5.5 JSON object IS the model: rows read and write paths into it, structural changes
 * re-render, parameter edits mutate in place and re-emit. Evaluation goes through the
 * server's POST /v1/admin/evaluate_condition so the Python evaluator stays the single truth
 * of the mini-language — the SPA never grows a second, drifting copy. The author's state
 * mock (flags/vars/inventory/visited/talk_counts/quests) answers "would this pass, given
 * this save?". */

import { api } from "./api";

export interface BuilderHandle {
  root: HTMLElement;
  getModel: () => unknown;
}

const LEAF_VERBS: Array<[string, string]> = [
  ["flag", "旗标 flag"],
  ["has_item", "持有 has_item"],
  ["var", "变量 var"],
  ["visited", "去过 visited"],
  ["talked", "谈过 talked"],
  ["quest_state", "任务进行到 quest_state"],
  ["quest_done", "任务完成 quest_done"],
  ["time_of_day", "时段 time_of_day"],
];

const MAX_DEPTH = 4;

function el(tag: string, className = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function isGroup(cond: unknown): boolean {
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) return false;
  const keys = Object.keys(cond as object);
  return keys.includes("all") || keys.includes("any") || keys.includes("not");
}

function groupKey(cond: unknown): "all" | "any" | "not" | null {
  if (!isGroup(cond)) return null;
  const keys = Object.keys(cond as object);
  if (keys.includes("all")) return "all";
  if (keys.includes("any")) return "any";
  return "not";
}

function leafVerb(cond: unknown): string | null {
  if (!cond || typeof cond !== "object" || Array.isArray(cond) || isGroup(cond)) return null;
  const keys = Object.keys(cond as object);
  for (const [verb] of LEAF_VERBS) {
    if (keys.includes(verb)) return verb;
  }
  return null;
}

function freshLeaf(verb: string): Record<string, unknown> {
  switch (verb) {
    case "has_item": return { has_item: "", count: 1 };
    case "var": return { var: "", op: ">=", value: 0 };
    case "talked": return { talked: "", min: 1 };
    case "quest_state": return { quest_state: "", node: "" };
    case "time_of_day": return { time_of_day: "day" };
    default: return { [verb]: "" };
  }
}

export function renderConditionBuilder(
  initial: unknown, externalChange: () => void,
): BuilderHandle {
  let model: unknown = initial ?? {};
  let evalTimer: number | undefined;

  const root = el("div");
  const modeRow = el("div", "row");
  const modeLabel = el("label");
  modeLabel.textContent = "根类型";
  const modeSelect = document.createElement("select");
  const treeHost = el("div");
  const addRow = el("div");
  const mirrorLabel = el("label");
  mirrorLabel.textContent = "§5.5 JSON（复制到实体的 complete_when / requires / reveal_if）";
  const jsonPre = el("pre", "mirror");
  const importArea = el("textarea", "tall") as HTMLTextAreaElement;
  importArea.placeholder = "粘贴条件 JSON 后点导入";
  const importBtn = el("button");
  importBtn.textContent = "导入 JSON";
  const badge = el("span", "badge");
  const stateLabel = el("label");
  stateLabel.textContent = "状态模拟（would this pass, given this state?）";
  const stateArea = el("textarea", "tall") as HTMLTextAreaElement;
  stateArea.value = JSON.stringify({
    flags: {}, vars: {}, inventory: {}, visited: {}, talk_counts: {}, quests: {},
    time_of_day: "day",
  }, null, 2);

  function emit(): void {
    jsonPre.textContent = JSON.stringify(model, null, 2) || String(model);
    externalChange();
    window.clearTimeout(evalTimer);
    evalTimer = window.setTimeout(() => void evaluate(), 400);
  }

  async function evaluate(): Promise<void> {
    try {
      const state = JSON.parse(stateArea.value);
      const result = await api.evaluateCondition({ condition: model, state }) as { pass: boolean };
      badge.textContent = result.pass ? "✓ 通过" : "✗ 不通过";
      badge.style.color = result.pass ? "var(--accent)" : "var(--danger)";
    } catch {
      badge.textContent = "· 求值失败（JSON 无效或后端未连接）";
      badge.style.color = "var(--warn)";
    }
  }

  function textInput(value: unknown, commit: (v: string) => void): HTMLElement {
    const input = document.createElement("input");
    input.value = String(value ?? "");
    input.oninput = () => { commit(input.value); emit(); };
    return input;
  }

  function numberInput(value: unknown, commit: (v: number) => void): HTMLElement {
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.value = String(value ?? 0);
    input.oninput = () => { commit(Number(input.value)); emit(); };
    return input;
  }

  function selectInput(options: string[], value: unknown, commit: (v: string) => void): HTMLElement {
    const select = document.createElement("select");
    for (const option of options) {
      const node = document.createElement("option");
      node.value = option;
      node.textContent = option;
      select.append(node);
    }
    select.value = String(value ?? options[0]);
    select.onchange = () => { commit(select.value); emit(); };
    return select;
  }

  function labeled(text: string, control: HTMLElement): HTMLElement {
    const label = el("label", "inline");
    label.append(document.createTextNode(text), control);
    return label;
  }

  function leafParams(container: HTMLElement, cond: Record<string, unknown>): void {
    switch (leafVerb(cond)) {
      case "flag":
        container.append(
          labeled("名", textInput(cond.flag, (v) => { cond.flag = v; })),
          labeled("应为", selectInput(["true", "false"], cond.value ?? "true",
            (v) => { cond.value = v === "true"; })),
        );
        break;
      case "has_item":
        container.append(
          labeled("物品", textInput(cond.has_item, (v) => { cond.has_item = v; })),
          labeled("数量", numberInput(cond.count ?? 1, (v) => { cond.count = v; })),
        );
        break;
      case "var":
        container.append(
          labeled("名", textInput(cond.var, (v) => { cond.var = v; })),
          labeled("比较", selectInput(["==", "!=", ">", ">=", "<", "<="], cond.op ?? ">=",
            (v) => { cond.op = v; })),
          labeled("值", numberInput(cond.value ?? 0, (v) => { cond.value = v; })),
        );
        break;
      case "visited":
        container.append(labeled("地点", textInput(cond.visited, (v) => { cond.visited = v; })));
        break;
      case "talked":
        container.append(
          labeled("NPC", textInput(cond.talked, (v) => { cond.talked = v; })),
          labeled("最少次数", numberInput(cond.min ?? 1, (v) => { cond.min = v; })),
        );
        break;
      case "quest_state":
        container.append(
          labeled("任务", textInput(cond.quest_state, (v) => { cond.quest_state = v; })),
          labeled("节点（留空=进行中）", textInput(cond.node, (v) => {
            if (v) cond.node = v; else cond.node = "";
          })),
        );
        break;
      case "quest_done":
        container.append(labeled("任务", textInput(cond.quest_done, (v) => { cond.quest_done = v; })));
        break;
      case "time_of_day":
        container.append(
          labeled("时段", selectInput(["day", "night"], cond.time_of_day ?? "day",
            (v) => { cond.time_of_day = v; })),
        );
        break;
    }
  }

  function renderCondNode(
    host: HTMLElement,
    get: () => unknown,
    set: (v: unknown) => void,
    remove: (() => void) | null,
    depth: number,
  ): void {
    const row = el("div", "cond-row");
    const cond = get();

    if (isGroup(cond)) {
      const key = groupKey(cond) as "all" | "any" | "not";
      const head = el("div", "cond-head");
      head.append(labeled(
        key === "not" ? "not 包裹（取反）" : `${key} 组（全部满足）`.replace("all", "全部满足").replace("any", "任一满足"),
        el("span"),
      ));
      const deleteBtn = el("button", "danger");
      deleteBtn.textContent = "×";
      deleteBtn.onclick = () => {
        if (remove) { remove(); rerender(); }
      };
      if (remove) head.append(deleteBtn);
      row.append(head);

      const childHost = el("div", "cond-children");
      if (key === "not") {
        const single = (cond as Record<string, unknown>)["not"];
        renderCondNode(
          childHost,
          () => single,
          (v) => { (cond as Record<string, unknown>)["not"] = v; },
          null,
          depth + 1,
        );
      } else {
        const arr = (cond as Record<string, unknown[]>)[key];
        arr.forEach((_, index) => {
          renderCondNode(
            childHost,
            () => arr[index],
            (v) => { arr[index] = v; },
            () => { arr.splice(index, 1); },
            depth + 1,
          );
        });
        if (depth + 1 < MAX_DEPTH) {
          const addBtn = el("button");
          addBtn.textContent = "＋ 加一条";
          addBtn.onclick = () => { arr.push({ flag: "" }); rerender(); };
          childHost.append(addBtn);
        }
      }
      row.append(childHost);
      host.append(row);
      return;
    }

    // Leaf row.
    const verb = leafVerb(cond);
    const verbSelect = document.createElement("select");
    for (const [value, label] of LEAF_VERBS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      verbSelect.append(option);
    }
    verbSelect.value = verb ?? LEAF_VERBS[0][0];
    verbSelect.onchange = () => { set(freshLeaf(verbSelect.value)); rerender(); };
    row.append(verbSelect);

    const params = el("div", "cond-params");
    if (verb != null) {
      leafParams(params, cond as Record<string, unknown>);
    }
    row.append(params);

    const deleteBtn = el("button", "danger");
    deleteBtn.textContent = "×";
    deleteBtn.onclick = () => {
      if (remove) { remove(); rerender(); }
    };
    if (remove) row.append(deleteBtn);
    host.append(row);
  }

  function rerender(): void {
    treeHost.textContent = "";
    addRow.textContent = "";

    const mode = groupKey(model);
    modeSelect.value = mode ?? (leafVerb(model) ? "single" : "empty");

    if (mode === "all" || mode === "any") {
      const arr = (model as Record<string, unknown[]>)[mode];
      arr.forEach((_, index) => {
        renderCondNode(
          treeHost,
          () => arr[index],
          (v) => { arr[index] = v; },
          () => { arr.splice(index, 1); },
          1,
        );
      });
      if (1 < MAX_DEPTH) {
        const addBtn = el("button");
        addBtn.textContent = "＋ 加一条";
        addBtn.onclick = () => { arr.push({ flag: "" }); rerender(); };
        addRow.append(addBtn);
      }
    } else {
      renderCondNode(treeHost, () => model, (v) => { model = v; }, null, 0);
    }
    emit();
  }

  modeSelect.onchange = () => {
    const leafNow = leafVerb(model) ? model : { flag: "" };
    const value = modeSelect.value;
    if (value === "empty") model = {};
    else if (value === "single") model = leafNow;
    else if (value === "not") model = { not: leafNow };
    else model = { [value]: [leafNow] };
    rerender();
  };
  for (const [value, label] of [
    ["empty", "无条件（恒真）"],
    ["single", "单条"],
    ["all", "all 组"],
    ["any", "any 组"],
    ["not", "not 包裹"],
  ] as Array<[string, string]>) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    modeSelect.append(option);
  }

  importBtn.onclick = () => {
    try {
      model = JSON.parse(importArea.value);
      rerender();
    } catch {
      importArea.classList.add("invalid");
      window.setTimeout(() => importArea.classList.remove("invalid"), 800);
    }
  };

  modeRow.append(modeLabel, modeSelect, badge);
  root.append(modeRow, treeHost, addRow, mirrorLabel, jsonPre, importArea, importBtn, stateLabel, stateArea);
  rerender();
  return { root, getModel: () => model };
}