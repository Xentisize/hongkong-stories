/* Persona playground (PLAN 9.2): chat with a draft NPC through the real pipeline.
 *
 * Per turn the response carries REAL usage (prompt/completion/cached tokens via
 * usage.include — the cache-hit telemetry PLAN 7.5 wanted), cost, latency, and the actions
 * the model TRIED that the allowlist rejected — surfaced in red, never hidden. History
 * feeds the next turn, capped like the client's 12-turn window. One click queues the line
 * for the fact-check review (§7.6). */

import { api, ApiError, DraftSummary, PlaygroundTurn } from "./api";
import { Entity } from "./form";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

interface Choice {
  kind: string;
  id: string;
  entity: Entity | null;
}

export function renderPlayground(): HTMLElement {
  const card = el("section", "card");

  const pickRow = el("div", "row");
  const npcSelect = document.createElement("select");
  const langSelect = document.createElement("select");
  for (const lang of ["zh_HK", "zh_CN", "en"]) {
    const option = document.createElement("option");
    option.value = lang;
    option.textContent = lang;
    langSelect.append(option);
  }
  const loadBtn = el("button");
  loadBtn.textContent = "载入 NPC";
  pickRow.append(npcSelect, langSelect, loadBtn);

  const stateLabel = el("label");
  stateLabel.textContent = "状态模拟（state projection，如同游戏内会话）";
  const stateArea = el("textarea") as HTMLTextAreaElement;
  stateArea.value = JSON.stringify(
    { flags: {}, vars: {}, inventory: {}, visited: {}, talk_counts: {}, quests: {} },
    null, 2,
  );

  const transcript = el("div", "transcript");
  const inputRow = el("div", "row");
  const input = document.createElement("input");
  input.placeholder = "以玩家身份说话…（Enter 发送）";
  const send = el("button", "primary");
  send.textContent = "发送";
  inputRow.append(input, send);
  input.onkeydown = (event) => {
    if (event.key === "Enter") void sendTurn();
  };
  send.onclick = () => void sendTurn();

  let npcEntity: Entity | null = null;
  let history: Array<{ role: string; content: string }> = [];

  async function loadChoices(): Promise<void> {
    npcSelect.textContent = "";
    const drafts = await api.drafts() as DraftSummary[];
    const npcs = await api.entities("npcs") as { entities: string[] };
    const choices: Choice[] = [
      ...drafts.filter((d) => d.kind === "npcs").map((d) => ({ kind: "draft", id: d.id, entity: null as Entity | null })),
      ...npcs.entities.map((id) => ({ kind: "baseline", id, entity: null as Entity | null })),
    ];
    for (const choice of choices) {
      const option = document.createElement("option");
      option.value = `${choice.kind}:${choice.id}`;
      option.textContent = (choice.kind === "draft" ? "草稿 · " : "") + choice.id;
      npcSelect.append(option);
    }
  }

  async function loadSelected(): Promise<void> {
    const [kind, id] = npcSelect.value.split(":");
    try {
      npcEntity = kind === "draft"
        ? await api.getDraft("npcs", id) as Entity
        : await api.entity("npcs", id) as Entity;
      history = [];
      transcript.textContent = "";
      const note = el("div", "turn");
      const who = el("div", "who");
      who.textContent = `已载入 ${id}`;
      note.append(who);
      transcript.append(note);
    } catch (err) {
      appendSystem(String(err instanceof ApiError ? err.message : err));
    }
  }

  function appendSystem(text: string): void {
    const note = el("div", "turn");
    const line = el("div", "line");
    line.style.color = "var(--danger)";
    line.textContent = text;
    note.append(line);
    transcript.append(note);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function statsLine(turn: PlaygroundTurn): string {
    const cached = Math.round((turn.usage.cache_ratio ?? 0) * 100);
    return [
      `⌛ ${turn.latency_ms}ms`,
      `in ${turn.usage.prompt_tokens} tok（cached ${cached}%）`,
      `out ${turn.usage.completion_tokens}`,
      `$${turn.usage.cost_usd}`,
      `mood: ${turn.mood}`,
      turn.truncated ? "· 截断!" : "",
    ].filter(Boolean).join(" · ");
  }

  function appendTurn(input: string, turn: PlaygroundTurn): void {
    const asked = el("div", "turn");
    const askedWho = el("div", "who");
    askedWho.textContent = "玩家";
    const askedLine = el("div", "line");
    askedLine.textContent = input;
    asked.append(askedWho, askedLine);
    transcript.append(asked);

    const reply = el("div", "turn");
    const who = el("div", "who");
    who.textContent = `${String(npcEntity?.id ?? "?")} · ${turn.model}`;
    const line = el("div", "line");
    line.textContent = turn.say;
    const stats = el("div", "stats");
    stats.textContent = statsLine(turn);
    reply.append(who, line, stats);

    if (turn.actions.length > 0) {
      const applied = el("div", "line");
      applied.style.color = "var(--accent)";
      applied.textContent = `动作: ${JSON.stringify(turn.actions)}`;
      reply.append(applied);
    }
    if (turn.rejected.length > 0) {
      const rejected = el("div", "rejected");
      const counts = new Map<string, number>();
      for (const r of turn.rejected) {
        counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
      }
      rejected.textContent = "被拒动作: " + [...counts.entries()].map(([r, n]) => `${r}×${n}`).join(", ");
      reply.append(rejected);
    }

    const check = el("button");
    check.textContent = "fact-check";
    check.onclick = async () => {
      check.disabled = true;
      try {
        const entry = await api.factcheckCheck({
          npc: npcEntity, player_input: input, reply: turn.say,
        }) as { verdict: string; reason: string; id: string };
        const verdict = el("div", `line verdict-${entry.verdict}`);
        verdict.textContent = `fact-check: ${entry.verdict} — ${entry.reason}（已入审阅队列）`;
        reply.append(verdict);
      } catch (err) {
        appendSystem(`fact-check 失败: ${describeError(err)}`);
      } finally {
        check.disabled = false;
      }
    };
    reply.append(check);
    transcript.append(reply);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function describeError(err: unknown): string {
    return err instanceof ApiError
      ? `${err.message}: ${typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail)}`
      : String(err);
  }

  async function sendTurn(): Promise<void> {
    const text = input.value.trim();
    if (!npcEntity || !text) return;
    let state: unknown;
    try {
      state = JSON.parse(stateArea.value);
    } catch {
      appendSystem("状态模拟不是合法 JSON");
      return;
    }
    send.disabled = true;
    try {
      const turn = await api.playground({
        npc: npcEntity, state, lang: langSelect.value, history, input: text,
      }) as PlaygroundTurn;
      history.push({ role: "user", content: text }, { role: "assistant", content: turn.say });
      while (history.length > 12) history.shift();
      appendTurn(text, turn);
      input.value = "";
    } catch (err) {
      appendSystem(`turn 失败: ${describeError(err)}`);
    } finally {
      send.disabled = false;
    }
  }

  loadBtn.onclick = () => void loadSelected();
  npcSelect.onchange = () => void loadSelected();
  void loadChoices().then(() => void loadSelected());

  card.append(pickRow, stateLabel, stateArea, transcript, inputRow);
  return card;
}