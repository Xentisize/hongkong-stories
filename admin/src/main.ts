/* Admin shell (PLAN 9.1): token, drafts list, baseline clone list, the NPC editor, and the
 * validate / publish actions. The P4 exit criterion lives here: author an NPC end to end —
 * persona, trigger, generated sprite — then publish; every booted client hot-packs it. */

import "./style.css";
import { api, ApiError, DraftSummary, Issue, getToken, setToken } from "./api";
import { blankNpc, Entity, renderNpcForm } from "./form";

const app = document.querySelector("#app") as HTMLElement;

interface Meta {
  content_version: number;
  content_hash: string;
  counts: Record<string, number>;
}

let status: HTMLElement;
let dirtyMark: HTMLElement;
let draftsList: HTMLElement;
let baselineList: HTMLElement;
let editor: HTMLElement;
let actionsRow: HTMLElement;
let feedback: HTMLElement;
let dirty = false;
let currentId: string | null = null;

function el(tag: string, className = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = typeof err.detail === "string"
      ? err.detail
      : JSON.stringify(err.detail, null, 2);
    return `${err.message}: ${detail}`;
  }
  return String(err);
}

function show(level: "ok" | "err" | "warn", text: string): void {
  feedback.className = `feedback ${level}`;
  feedback.textContent = text;
}

function markDirty(): void {
  dirty = true;
  dirtyMark.textContent = "●";
}

function markClean(): void {
  dirty = false;
  dirtyMark.textContent = "";
}

async function refreshMeta(): Promise<void> {
  try {
    const meta = await api.meta() as Meta;
    const npcs = meta.counts["npcs"] ?? 0;
    status.textContent = `content v${meta.content_version} (${meta.content_hash}) · npcs ${npcs}`;
  } catch {
    status.textContent = "未连接后端 / backend unreachable";
  }
}

async function refreshLists(): Promise<void> {
  draftsList.textContent = "";
  const drafts = await api.drafts() as DraftSummary[];
  if (drafts.length === 0) {
    const empty = el("li");
    empty.style.color = "var(--muted)";
    empty.textContent = "（无草稿）";
    draftsList.append(empty);
  }
  for (const draft of drafts) {
    const li = el("li");
    li.textContent = draft.id;
    const kind = el("span", "kind");
    kind.textContent = draft.kind;
    li.append(kind);
    li.onclick = () => void openDraft(draft.kind, draft.id);
    draftsList.append(li);
  }

  baselineList.textContent = "";
  const npcs = await api.entities("npcs") as { entities: string[] };
  for (const id of npcs.entities) {
    const li = el("li");
    li.textContent = id;
    const kind = el("span", "kind");
    kind.textContent = "克隆";
    li.append(kind);
    li.onclick = () => void cloneDraft(id);
    baselineList.append(li);
  }
}

async function openDraft(kind: string, id: string): Promise<void> {
  try {
    const entity = await api.getDraft(kind, id) as Entity;
    showEditor(entity, false);
  } catch (err) {
    show("err", describeError(err));
  }
}

async function cloneDraft(id: string): Promise<void> {
  try {
    const entity = await api.entity("npcs", id) as Entity;
    entity.id = `${id}_v2`;
    showEditor(entity, true);
    show("warn", `已载入基线 ${id} — 改好 id 与内容后保存为草稿`);
  } catch (err) {
    show("err", describeError(err));
  }
}

function showEditor(entity: Entity, isNew: boolean): void {
  currentId = String(entity.id);
  editor.textContent = "";
  editor.append(renderNpcForm(entity, { onChange: markDirty }, isNew));
  feedback.className = "feedback";
  markClean();
  wireActions(entity, isNew);
}

function wireActions(entity: Entity, isNew: boolean): void {
  actionsRow.textContent = "";

  const save = el("button", "primary");
  save.textContent = isNew ? "保存草稿 Save" : "保存 Save";
  save.onclick = () => void saveDraft(entity);

  const remove = el("button", "danger");
  remove.textContent = "删草稿 Discard";
  remove.onclick = () => void removeDraft(entity.id);

  const validate = el("button");
  validate.textContent = "校验 Validate";
  validate.onclick = () => void runValidate();

  const publish = el("button");
  publish.textContent = "发布 Publish";
  publish.onclick = () => void runPublish();

  actionsRow.append(save, remove, validate, publish);
}

async function saveDraft(entity: Entity): Promise<void> {
  try {
    await api.putDraft("npcs", String(entity.id), entity);
    currentId = String(entity.id);
    markClean();
    show("ok", `草稿已保存 / draft saved: ${entity.id}`);
    await refreshLists();
  } catch (err) {
    show("err", describeError(err));
  }
}

async function removeDraft(id: string): Promise<void> {
  if (!window.confirm(`删除草稿 ${id}？`)) return;
  try {
    await api.deleteDraft("npcs", id);
    show("ok", `草稿已删除 / draft discarded: ${id}`);
    await refreshLists();
  } catch (err) {
    show("err", describeError(err));
  }
}

function formatIssues(issues: Issue[]): string {
  return issues
    .map((i) => `[${i.level === "error" ? "E" : "W"}] ${i.path}: ${i.message}`)
    .join("\n");
}

async function runValidate(): Promise<void> {
  try {
    const result = await api.validate() as { ok: boolean; issues: Issue[] };
    const errors = result.issues.filter((i) => i.level === "error").length;
    if (result.ok) {
      show("ok", `校验通过 / valid（${result.issues.length} 条提示）\n${formatIssues(result.issues)}`);
    } else {
      show("err", `校验未通过 / ${errors} 个错误\n${formatIssues(result.issues)}`);
    }
  } catch (err) {
    show("err", describeError(err));
  }
}

async function runPublish(): Promise<void> {
  if (!window.confirm("发布会把草稿并入正式内容包并递增版本，所有客户端在下次启动时热更新。继续？")) {
    return;
  }
  try {
    const result = await api.publish() as { published: number; version: number; content_hash: string };
    markClean();
    show("ok", `已发布 / published ${result.published} 个草稿 → content v${result.version} (${result.content_hash})`);
    await refreshMeta();
    await refreshLists();
  } catch (err) {
    show("err", describeError(err));
  }
}

function boot(): void {
  status = el("span", "status");
  dirtyMark = el("span");
  dirtyMark.style.color = "var(--warn)";

  const bar = el("header", "bar");
  const title = el("h1");
  title.textContent = "HONG KONG STORIES — ADMIN";
  const tokenInput = document.createElement("input");
  tokenInput.type = "password";
  tokenInput.placeholder = "ADMIN_TOKEN";
  tokenInput.value = getToken();
  const applyToken = el("button");
  applyToken.textContent = "连接 Connect";
  applyToken.onclick = async () => {
    setToken(tokenInput.value.trim());
    await refreshMeta();
    await refreshLists();
  };
  bar.append(title, tokenInput, applyToken, dirtyMark, status);
  app.append(bar);

  const layout = el("div", "layout");

  const aside = el("aside");
  const draftsHead = el("h2");
  draftsHead.textContent = "草稿 Drafts";
  draftsList = el("ul");
  const baselineHead = el("h2");
  baselineHead.textContent = "基线 NPC（点按克隆）";
  baselineList = el("ul");
  const newBtn = el("button");
  newBtn.textContent = "＋ 新建 NPC";
  newBtn.onclick = () => {
    showEditor(blankNpc(), true);
    show("warn", "新 NPC：填好 id（如 npc_ch01_hawker）、三语名称与内容后保存");
  };
  aside.append(draftsHead, draftsList, baselineHead, baselineList, newBtn);

  const card = el("section", "card");
  editor = el("div");
  actionsRow = el("div", "actions");
  feedback = el("div", "feedback");
  card.append(editor, actionsRow, feedback);

  layout.append(aside, card);
  app.append(layout);

  void refreshMeta();
  void refreshLists();
}

boot();