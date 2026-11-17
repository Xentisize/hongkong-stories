/* Review view (PLAN 9.2): the fact-check queue + the usage dashboard.
 *
 * Queue rule from §7.6: entries are flagged for human review and resolved by a person;
 * nothing here ever rewrites the player's words. The dashboard aggregates the month's JSONL
 * usage log server-side: spend (chat / image / fact-check), turns, tokens, p95 latency,
 * top rejected action reasons, costliest sessions. */

import { api, FactEntry, UsageSummary } from "./api";

function el(tag: string, className = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function renderReview(): HTMLElement {
  const wrap = el("div");

  const queueCard = el("section", "card");
  const queueHead = el("h2");
  queueHead.textContent = "Fact-check 审阅队列（§7.6：只标记，从不改写玩家的话）";
  const queueList = el("div");
  queueCard.append(queueHead, queueList);

  const usageCard = el("section", "card");
  const usageHead = el("h2");
  usageHead.textContent = "用量 · 本月";
  const usageHost = el("div");
  usageCard.append(usageHead, usageHost);

  wrap.append(queueCard, usageCard);

  function chip(verdict: string): HTMLElement {
    const node = el("span", `chip ${verdict}`);
    node.textContent = verdict;
    return node;
  }

  function excerpt(text: string, limit = 80): string {
    return text.length > limit ? text.slice(0, limit) + "…" : text;
  }

  async function resolve(id: string, status: string, row: HTMLElement): Promise<void> {
    try {
      await api.factcheckResolve(id, status);
      await refresh();
    } catch (err) {
      const note = el("div", "rejected");
      note.textContent = `resolve 失败: ${String(err)}`;
      row.append(note);
    }
  }

  async function refresh(): Promise<void> {
    queueList.textContent = "";
    let entries: FactEntry[] = [];
    try {
      entries = await api.factcheckList() as FactEntry[];
    } catch (err) {
      const note = el("div");
      note.style.color = "var(--danger)";
      note.textContent = `队列加载失败: ${String(err)}`;
      queueList.append(note);
    }

    if (entries.length === 0) {
      const empty = el("div");
      empty.style.color = "var(--muted)";
      empty.textContent = "（队列为空 — 在 Playground 对某轮回复点 fact-check）";
      queueList.append(empty);
    }
    for (const entry of entries) {
      const row = el("div", "turn");
      const head = el("div", "who");
      head.append(chip(entry.verdict));
      head.append(document.createTextNode(
        `  ${entry.npc_id || "?"} · ${entry.status} · ${entry.ts.slice(0, 16).replace("T", " ")}`,
      ));
      const line = el("div", "line");
      line.textContent = excerpt(`玩家: ${entry.player_input || "（无）"} → NPC: ${entry.reply}`);
      const reason = el("div", "stats");
      reason.textContent = entry.reason;
      row.append(head, line, reason);
      if (entry.status === "open") {
        const actions = el("div");
        const dismiss = el("button");
        dismiss.textContent = "驳回 Dismiss";
        dismiss.onclick = () => void resolve(entry.id, "dismissed", row);
        const confirm = el("button");
        confirm.textContent = "确认 Confirmed";
        confirm.onclick = () => void resolve(entry.id, "confirmed", row);
        actions.append(dismiss, confirm);
        row.append(actions);
      }
      queueList.append(row);
    }

    usageHost.textContent = "";
    let usage: UsageSummary;
    try {
      usage = await api.usage() as UsageSummary;
    } catch (err) {
      usageHost.textContent = `用量加载失败: ${String(err)}`;
      return;
    }

    const grid = el("div", "stat-grid");
    const stats: Array<[string, string]> = [
      [`$${usage.chat_cost_usd}`, "对话花费（本月）"],
      [`$${usage.image_cost_usd}`, "图像花费"],
      [`$${usage.factcheck_cost_usd ?? 0}`, "fact-check 花费"],
      [`${usage.turns}`, "轮数"],
      [`${usage.tokens}`, "tokens"],
      [`${usage.p95_latency_ms}ms`, "p95 延迟"],
    ];
    for (const [value, title] of stats) {
      const stat = el("div", "stat");
      const number = el("div", "n");
      number.textContent = value;
      const name = el("div", "t");
      name.textContent = title;
      stat.append(number, name);
      grid.append(stat);
    }
    usageHost.append(grid);

    const rejected = document.createElement("table");
    rejected.className = "grid";
    rejected.append(_headerRow(["被拒原因", "次数"]));
    if (usage.top_rejected.length === 0) {
      rejected.append(_emptyRow("（没有被拒动作）", 2));
    }
    for (const item of usage.top_rejected) {
      const tr = document.createElement("tr");
      const reason = document.createElement("td");
      reason.textContent = item.reason;
      const count = document.createElement("td");
      count.textContent = String(item.count);
      tr.append(reason, count);
      rejected.append(tr);
    }
    usageHost.append(rejected);

    const sessions = document.createElement("table");
    sessions.className = "grid";
    sessions.append(_headerRow(["会话", "轮数", "花费 $"]));
    if (usage.sessions.length === 0) {
      sessions.append(_emptyRow("（本月暂无会话记录）", 3));
    }
    for (const item of usage.sessions) {
      const tr = document.createElement("tr");
      const token = document.createElement("td");
      token.textContent = item.session.slice(0, 12) + "…";
      const turns = document.createElement("td");
      turns.textContent = String(item.turns);
      const cost = document.createElement("td");
      cost.textContent = String(item.cost_usd);
      tr.append(token, turns, cost);
      sessions.append(tr);
    }
    usageHost.append(sessions);
  }

  function _headerRow(cells: string[]): HTMLElement {
    const tr = document.createElement("tr");
    for (const text of cells) {
      const th = document.createElement("th");
      th.textContent = text;
      tr.append(th);
    }
    return tr;
  }

  function _emptyRow(text: string, span: number): HTMLElement {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = span;
    td.style.color = "var(--muted)";
    td.textContent = text;
    tr.append(td);
    return tr;
  }

  void refresh();
  return wrap;
}