/* Admin shell (PLAN 9.1, 9.2): token + nav over four views —
 *   Editor     draft authoring (NPC form, clone-from-baseline, art, validate/publish)
 *   Playground chat with a draft NPC; per-turn real usage, rejected actions, fact-check
 *   Builder    condition rule rows → §5.5 JSON with live evaluation
 *   Review     fact-check queue + usage dashboard
 *
 * The editor's bound entity object survives tab switches, as does the builder's model —
 * switching views never discards unsaved work. */

import "./style.css";
import { api, ApiError, DraftSummary, Issue, getToken, setToken } from "./api";
import { blankNpc, Entity, renderNpcForm } from "./form";
import { renderConditionBuilder, BuilderHandle } from "./builder";
import { renderPlayground } from "./playground";
import { renderReview } from "./review";

type ViewName = "editor" | "playground" | "builder" | "review";

const app = document.querySelector("#app") as HTMLElement;

interface Meta {
  content_version: number;
  content_hash: string;
  counts: Record<string, number>;
}

let status: HTMLElement;
let dirtyMark: HTMLElement;
let viewHost: HTMLElement;
const navButtons: Partial<Record<ViewName, HTMLElement>> = {};
let currentView: ViewName = "editor";

let editorEntity: Entity | null = null;
let editorIsNew = false;
let dirty = false;
let editorFeedback: HTMLElement | null = null;
let builderHandle: BuilderHandle | null = null;
let builderModel: unknown = { flag: "" };

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
  if (!editorFeedback) return;
  editorFeedback.className = `feedback ${level}`;
  editorFeedback.textContent = text;
}

function markDirty(): void {
  dirty = true;
  dirtyMark.textContent = "● 未保存";
}

function markClean(): void {
  dirty = false;
  dirtyMark.textContent = "";
}

async function refreshMeta(): Promise<void> {
  try {
    const meta = await api.meta() as Meta;
    status.textContent =
      `content v${meta.content_version} (${meta.content_hash}) · npcs ${meta.counts["npcs"] ?? 0}`;
  } catch {
    status.textContent = "未连接后端 / backend unreachable";
  }
}

/* ---------- editor view ---------- */

async function refreshLists(draftsList: HTMLElement, baselineList: HTMLElement): Promise<void> {
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
    editorEntity = await api.getDraft(kind, id) as Entity;
    editorIsNew = false;
    showView("editor");
  } catch (err) {
    show("err", describeError(err));
  }
}

async function cloneDraft(id: string): Promise<void> {
  try {
    editorEntity = await api.entity("npcs", id) as Entity;
    editorEntity.id = `${id}_v2`;
    editorIsNew = true;
    showView("editor");
    show("warn", `已载入基线 ${id} — 改好 id 与内容后保存为草稿`);
  } catch (err) {
    show("err", describeError(err));
  }
}

function wireActions(entity: Entity, isNew: boolean, actionsRow: HTMLElement): void {
  actionsRow.textContent = "";

  const save = el("button", "primary");
  save.textContent = isNew ? "保存草稿 Save" : "保存 Save";
  save.onclick = () => void saveDraft(entity);

  const remove = el("button", "danger");
  remove.textContent = "删草稿 Discard";
  remove.onclick = () => void removeDraft(String(entity.id));

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
    editorIsNew = false;
    markClean();
    show("ok", `草稿已保存 / draft saved: ${entity.id}`);
  } catch (err) {
    show("err", describeError(err));
  }
}

async function removeDraft(id: string): Promise<void> {
  if (!window.confirm(`删除草稿 ${id}？`)) return;
  try {
    await api.deleteDraft("npcs", id);
    show("ok", `草稿已删除 / draft discarded: ${id}`);
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
  let preview: { added: Array<{ kind: string; id: string }>; changed: Array<{ kind: string; id: string }> };
  try {
    preview = await api.publishPreview() as typeof preview;
  } catch (err) {
    show("err", describeError(err));
    return;
  }
  const lines = [
    ...preview.added.map((e) => `＋ 新增 ${e.kind}/${e.id}`),
    ...preview.changed.map((e) => `~ 修改 ${e.kind}/${e.id}`),
  ];
  const summary = lines.length ? lines.join("\n") : "（草稿与基线一致或无草稿）";
  if (!window.confirm(`发布会把草稿并入正式内容包并递增版本，所有客户端下次启动热更新。\n将应用：\n${summary}\n继续？`)) {
    return;
  }
  try {
    const result = await api.publish() as { published: number; version: number; content_hash: string };
    editorIsNew = false;
    markClean();
    show("ok", `已发布 / published ${result.published} 个草稿 → content v${result.version} (${result.content_hash})`);
    await refreshMeta();
  } catch (err) {
    show("err", describeError(err));
  }
}

function editorView(): HTMLElement {
  const wrap = el("div", "layout");
  const aside = el("aside");
  const draftsHead = el("h2");
  draftsHead.textContent = "草稿 Drafts";
  const draftsList = el("ul");
  const baselineHead = el("h2");
  baselineHead.textContent = "基线 NPC（点按克隆）";
  const baselineList = el("ul");
  const newBtn = el("button");
  newBtn.textContent = "＋ 新建 NPC";
  newBtn.onclick = () => {
    editorEntity = blankNpc();
    editorIsNew = true;
    showView("editor");
    show("warn", "新 NPC：填好 id（如 npc_ch01_hawker）、三语名称与内容后保存");
  };
  aside.append(draftsHead, draftsList, baselineHead, baselineList, newBtn);

  const card = el("section", "card");
  const editorHost = el("div");
  const actionsRow = el("div", "actions");
  const feedback = el("div", "feedback");
  editorFeedback = feedback;
  card.append(editorHost, actionsRow, feedback);
  wrap.append(aside, card);

  if (editorEntity) {
    editorHost.append(renderNpcForm(editorEntity, { onChange: markDirty }, editorIsNew));
    wireActions(editorEntity, editorIsNew, actionsRow);
  } else {
    const hint = el("div");
    hint.style.color = "var(--muted)";
    hint.textContent = "从左侧选择草稿、克隆基线 NPC，或新建一个。";
    editorHost.append(hint);
  }

  void refreshLists(draftsList, baselineList);
  return wrap;
}

/* ---------- other views ---------- */

function playgroundView(): HTMLElement {
  return renderPlayground();
}

function builderView(): HTMLElement {
  const card = el("section", "card");
  builderHandle = renderConditionBuilder(builderModel, () => {});
  card.append(builderHandle.root);
  return card;
}

function reviewView(): HTMLElement {
  return renderReview();
}

function showView(name: ViewName): void {
  if (currentView === "builder" && name !== "builder") {
    builderModel = builderHandle?.getModel() ?? builderModel;
  }
  currentView = name;
  for (const key of Object.keys(navButtons) as ViewName[]) {
    navButtons[key]?.classList.toggle("active", key === name);
  }
  viewHost.textContent = "";
  if (name === "editor") viewHost.append(editorView());
  else if (name === "playground") viewHost.append(playgroundView());
  else if (name === "builder") viewHost.append(builderView());
  else viewHost.append(reviewView());
}

/* ---------- boot ---------- */

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
  };
  bar.append(title, tokenInput, applyToken, dirtyMark, status);
  app.append(bar);

  const tabs = el("div", "tabs");
  const views: Array<[ViewName, string]> = [
    ["editor", "编辑 Editor"],
    ["playground", "调试 Playground"],
    ["builder", "条件 Builder"],
    ["review", "审阅 Review"],
  ];
  for (const [name, label] of views) {
    const button = el("button");
    button.textContent = label;
    button.onclick = () => showView(name);
    navButtons[name] = button;
    tabs.append(button);
  }
  app.append(tabs);

  viewHost = el("div");
  app.append(viewHost);

  showView("editor");
  void refreshMeta();
}

boot();