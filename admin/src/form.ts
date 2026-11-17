/* NPC editor form (PLAN 9.2).
 *
 * The form binds a plain entity object in memory: every control mutates it and calls
 * onChange; the shell decides when to persist. Structured sub-objects (secrets, fallback
 * lines, trigger.requires) are edited as JSON in a validating textarea — invalid JSON is
 * flagged and never half-committed. The Seedream block generates art straight into the
 * content pack and writes the returned pack-relative path back into the draft.
 */

import { api, ApiError } from "./api";

export type Entity = Record<string, any>;

export interface FormBindings {
  onChange: () => void;
}

function el(tag: string, className = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function section(title: string, children: HTMLElement[]): HTMLElement {
  const box = el("div");
  const head = el("h2");
  head.textContent = title;
  box.append(head, ...children);
  return box;
}

function field(labelText: string, control: HTMLElement): HTMLElement {
  const wrap = el("div");
  const label = el("label");
  label.textContent = labelText;
  wrap.append(label, control);
  return wrap;
}

function textControl(value: string, oninput: (v: string) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.value = value;
  input.oninput = () => oninput(input.value);
  return input;
}

function areaControl(value: string, oninput: (v: string) => void, tall = false): HTMLTextAreaElement {
  const area = document.createElement("textarea");
  if (tall) area.classList.add("tall");
  area.value = value;
  area.spellcheck = false;
  area.oninput = () => oninput(area.value);
  return area;
}

function textField(labelText: string, value: string, oninput: (v: string) => void): HTMLElement {
  return field(labelText, textControl(value, oninput));
}

function areaField(labelText: string, value: string, oninput: (v: string) => void, tall = false): HTMLElement {
  return field(labelText, areaControl(value, oninput, tall));
}

function localeFields(
  name: string, obj: Record<string, string>, onChange: () => void,
): HTMLElement {
  const row = el("div", "row");
  const hints: Array<[string, string]> = [
    ["zh_HK", "zh_HK（正典）"],
    ["zh_CN", "zh_CN（书面语，禁粤语虚词）"],
    ["en", "en"],
  ];
  for (const [key, hint] of hints) {
    row.append(field(
      `${name} · ${hint}`,
      textControl(String(obj[key] ?? ""), (v) => { obj[key] = v; onChange(); }),
    ));
  }
  return row;
}

function commaField(
  labelText: string, values: string[] | undefined,
  onCommit: (v: string[]) => void, onChange: () => void,
): HTMLElement {
  return field(labelText, textControl((values ?? []).join(", "), (v) => {
    onCommit(v.split(",").map((s) => s.trim()).filter(Boolean));
    onChange();
  }));
}

function lineListField(
  labelText: string, values: string[] | undefined,
  onCommit: (v: string[]) => void, onChange: () => void,
): HTMLElement {
  return field(labelText, areaControl((values ?? []).join("\n"), (v) => {
    onCommit(v.split("\n").map((s) => s.trim()).filter(Boolean));
    onChange();
  }));
}

function numberField(
  labelText: string, value: number, onCommit: (v: number) => void, onChange: () => void,
): HTMLElement {
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.value = String(value ?? 0);
  input.oninput = () => { onCommit(Number(input.value)); onChange(); };
  return field(labelText, input);
}

function checkboxes(
  labelText: string, options: string[], selected: string[] | undefined,
  onCommit: (v: string[]) => void, onChange: () => void,
): HTMLElement {
  const wrap = el("div");
  const label = el("label");
  label.textContent = labelText;
  wrap.append(label);
  const row = el("div", "row");
  const current = new Set(selected ?? []);
  for (const option of options) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = current.has(option);
    box.onchange = () => {
      if (box.checked) current.add(option); else current.delete(option);
      onCommit([...current]);
      onChange();
    };
    const item = el("label", "inline");
    item.append(box, document.createTextNode(option));
    row.append(item);
  }
  wrap.append(row);
  return wrap;
}

function jsonArea(
  labelText: string, value: unknown, onCommit: (v: unknown) => void, onChange: () => void,
): HTMLElement {
  const area = areaControl(JSON.stringify(value ?? null, null, 2), () => {
    try {
      onCommit(JSON.parse(area.value));
      area.classList.remove("invalid");
      onChange();
    } catch {
      area.classList.add("invalid");
    }
  }, true);
  return field(labelText, area);
}

function idField(entity: Entity, isNew: boolean, onChange: () => void): HTMLElement {
  const input = textControl(String(entity.id ?? ""), (v) => { entity.id = v; onChange(); });
  if (!isNew) input.readOnly = true;
  return field(isNew ? "id（新草稿，可定名）" : "id", input);
}

function asObject(value: unknown): Entity {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Entity
    : {};
}

function applyArtPath(entity: Entity, kind: string, path: string): void {
  const sprite = asObject(entity.sprite);
  if (kind === "sprite") {
    sprite.sheet = path;
    sprite.frames = { idle: [0] };
  } else if (kind === "portrait") {
    sprite.portrait = path;
  } else {
    const props: string[] = Array.isArray(sprite.props) ? sprite.props as string[] : [];
    if (!props.includes(path)) props.push(path);
    sprite.props = props;
  }
  entity.sprite = sprite;
}

function artBlock(entity: Entity, onChange: () => void): HTMLElement {
  const wrap = el("div");
  const row = el("div", "row");
  const kindSelect = document.createElement("select");
  for (const kind of ["sprite", "portrait", "prop"]) {
    const option = document.createElement("option");
    option.value = kind;
    option.textContent = kind;
    kindSelect.append(option);
  }
  const descInput = textControl("", () => {});
  descInput.placeholder = "subject description for Seedream (English works best)";
  const bibleCheck = document.createElement("input");
  bibleCheck.type = "checkbox";
  bibleCheck.checked = true;
  bibleCheck.title = "art/stylebible.png 存在时作为 input_references[0] 随每次生成（§8.2）";
  const bibleLabel = el("label", "inline");
  bibleLabel.append(bibleCheck, document.createTextNode("风格基准"));
  const generate = document.createElement("button");
  generate.textContent = "生成 Generate";
  const note = el("div");
  note.style.color = "var(--muted)";
  const preview = document.createElement("img");
  preview.className = "preview hidden";
  preview.alt = "generated art preview";

  const sheetPath = asObject(entity.sprite).sheet;
  if (typeof sheetPath === "string" && sheetPath) {
    preview.src = `/v1/content/file/${sheetPath}`;
    preview.classList.remove("hidden");
  }

  generate.onclick = async () => {
    const kind = kindSelect.value;
    const desc = descInput.value.trim();
    if (!desc) {
      note.textContent = "需要描述 / desc required";
      return;
    }
    generate.disabled = true;
    note.textContent = "生成中… / generating…";
    try {
      const result = await api.generateArt({
        kind, subject_id: String(entity.id), desc, use_style_bible: bibleCheck.checked,
      }) as Entity;
      const path = String(result.path);
      applyArtPath(entity, kind, path);
      preview.src = `data:image/png;base64,${String(result.png_base64)}`;
      preview.classList.remove("hidden");
      note.textContent =
        `已写入 ${path} · cost $${result.cost_usd} · seed ${result.seed} — 记得 Save 草稿`;
      onChange();
    } catch (err) {
      note.textContent = err instanceof ApiError
        ? `${err.message}: ${typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail)}`
        : String(err);
      note.style.color = "var(--danger)";
    } finally {
      generate.disabled = false;
    }
  };

  row.append(kindSelect, descInput, bibleLabel, generate);
  wrap.append(row, preview, note);
  return wrap;
}

export function renderNpcForm(entity: Entity, bind: FormBindings, isNew: boolean): HTMLElement {
  const touch = bind.onChange;

  // Make sure every sub-object the form touches exists (a blank draft or a thin clone).
  entity.display_name ??= { zh_HK: "", zh_CN: "", en: "" };
  entity.persona ??= {};
  entity.persona.role ??= "";
  entity.persona.voice ??= "";
  entity.persona.wants ??= "";
  entity.persona.taboos ??= [];
  entity.persona.knowledge_tags ??= [];
  entity.llm ??= {};
  entity.llm.actions_allowed ??= [];
  entity.llm.items_may_give ??= [];
  entity.llm.flags_may_set ??= [];
  entity.secrets ??= [];
  entity.scripted_fallback ??= {};
  entity.scripted_fallback.greeting ??= { zh_HK: "", zh_CN: "", en: "" };
  entity.scripted_fallback.lines ??= [];
  entity.scripted_fallback.exit ??= { zh_HK: "", zh_CN: "", en: "" };
  entity.trigger ??= {};

  const root = el("div");
  root.append(
    section("身份 Identity", [
      idField(entity, isNew, touch),
      textField("era", String(entity.era ?? ""), (v) => { entity.era = v || null; touch(); }),
      localeFields("display_name", entity.display_name, touch),
    ]),
    section("Persona", [
      areaField("role", entity.persona.role, (v) => { entity.persona.role = v; touch(); }),
      areaField("voice", entity.persona.voice, (v) => { entity.persona.voice = v; touch(); }),
      areaField("wants", entity.persona.wants, (v) => { entity.persona.wants = v; touch(); }),
      lineListField("taboos（每行一条）", entity.persona.taboos,
        (v) => { entity.persona.taboos = v; }, touch),
      commaField("knowledge_tags", entity.persona.knowledge_tags,
        (v) => { entity.persona.knowledge_tags = v; }, touch),
    ]),
    section("Lore（模型唯一的事实来源 §7.2）", [
      areaField("lore", String(entity.lore ?? ""), (v) => { entity.lore = v; touch(); }, true),
    ]),
    section("LLM 允许清单（安全边界 §5.1）", [
      numberField("temperature", Number(entity.llm.temperature ?? 0.85),
        (v) => { entity.llm.temperature = v; }, touch),
      numberField("max_tokens", Number(entity.llm.max_tokens ?? 320),
        (v) => { entity.llm.max_tokens = v; }, touch),
      checkboxes("actions_allowed", ["give", "take", "set_flag", "var", "reveal_secret", "open_shop"],
        entity.llm.actions_allowed, (v) => { entity.llm.actions_allowed = v; }, touch),
      commaField("items_may_give", entity.llm.items_may_give,
        (v) => { entity.llm.items_may_give = v; }, touch),
      commaField("flags_may_set", entity.llm.flags_may_set,
        (v) => { entity.llm.flags_may_set = v; }, touch),
    ]),
    section("Secrets（reveal_if 决定何时可讲）", [
      jsonArea("secrets（JSON 数组）", entity.secrets, (v) => { entity.secrets = v; }, touch),
    ]),
    section("Scripted fallback（离线保底 §7.4）", [
      localeFields("greeting", entity.scripted_fallback.greeting, touch),
      jsonArea("lines（JSON 数组；条目为三语文本或 {text, requires, actions}）",
        entity.scripted_fallback.lines, (v) => { entity.scripted_fallback.lines = v; }, touch),
      localeFields("exit", entity.scripted_fallback.exit, touch),
    ]),
    section("Trigger / Sprite", [
      textField("trigger.location", String(entity.trigger.location ?? ""),
        (v) => { entity.trigger.location = v || null; touch(); }),
      jsonArea("trigger.requires（JSON 条件或 null）", entity.trigger.requires,
        (v) => { entity.trigger.requires = v; }, touch),
      artBlock(entity, touch),
    ]),
  );
  return root;
}

export function blankNpc(): Entity {
  return {
    schema_version: 1,
    id: "npc_ch01_new",
    era: "ch01_hk_2027",
    sprite: null,
    display_name: { zh_HK: "", zh_CN: "", en: "" },
    persona: { role: "", voice: "", wants: "", taboos: [], knowledge_tags: [] },
    lore: "",
    llm: {
      model: null,
      temperature: 0.85,
      max_tokens: 320,
      language_follow_player: true,
      actions_allowed: [],
      items_may_give: [],
      flags_may_set: [],
      vars_may_change: {},
    },
    secrets: [],
    scripted_fallback: {
      greeting: { zh_HK: "", zh_CN: "", en: "" },
      lines: [],
      exit: { zh_HK: "", zh_CN: "", en: "" },
    },
    trigger: { location: "loc_ssp_market_street", requires: null },
  };
}