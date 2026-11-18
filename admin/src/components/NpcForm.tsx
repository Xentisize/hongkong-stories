/* NPC editor form (PLAN 9.2), React port of `src/form.ts`.
 *
 * The form binds a plain entity object in memory: every control mutates it and calls
 * `onChange`; the editor decides when to persist. Structured sub-objects (secrets, fallback
 * lines, trigger.requires) are edited as JSON in a textarea that reports invalid JSON inline
 * and never half-commits.
 *
 * Two deliberate changes from the DOM version:
 *
 *  - **Locale tabs instead of three stacked inputs.** §9.2 asks for one tab per locale with a
 *    completeness dot; stacked inputs made a missing `en` string invisible, and at three
 *    languages per field that is most of the form.
 *  - **`missingLocales` comes from `@hkstories/core`**, the same function the publish gate and
 *    the client use, so the dot an author sees here agrees with what validation will report.
 *
 * The component is mounted with `key={draftKey}` by its parent, so switching drafts remounts it
 * and local text state cannot leak between drafts.
 */

import { useState, type ReactNode } from "react";

import { LOCALES, missingLocales } from "@hkstories/core";

import { ApiError, api } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { applyArtPath, asObject, ensureNpcShape, type Entity } from "@/lib/npc";

const ACTION_OPTIONS = ["give", "take", "set_flag", "var", "reveal_secret", "open_shop"];

const LOCALE_HINTS: Record<string, string> = {
  zh_HK: "正典",
  zh_CN: "书面语，禁粤语虚词",
  en: "English",
};

export interface NpcFormProps {
  entity: Entity;
  isNew: boolean;
  onChange: () => void;
}

export function NpcForm({ entity, isNew, onChange }: NpcFormProps) {
  ensureNpcShape(entity);
  const persona = asObject(entity["persona"]);
  const llm = asObject(entity["llm"]);
  const fallback = asObject(entity["scripted_fallback"]);
  const trigger = asObject(entity["trigger"]);

  return (
    <div className="space-y-4">
      <Section title="身份 Identity">
        <Field label={isNew ? "id（新草稿，可定名）" : "id"}>
          <Input
            value={String(entity["id"] ?? "")}
            readOnly={!isNew}
            className={cn(!isNew && "opacity-70")}
            onChange={(event) => {
              entity["id"] = event.target.value;
              onChange();
            }}
          />
        </Field>
        <Field label="era">
          <Input
            value={String(entity["era"] ?? "")}
            onChange={(event) => {
              entity["era"] = event.target.value || null;
              onChange();
            }}
          />
        </Field>
        <LocaleTabs
          label="display_name"
          value={entity["display_name"]}
          onChange={(next) => {
            entity["display_name"] = next;
            onChange();
          }}
        />
      </Section>

      <Section title="Persona">
        <TextField
          label="role"
          value={String(persona["role"] ?? "")}
          rows={2}
          onChange={(v) => {
            persona["role"] = v;
            onChange();
          }}
        />
        <TextField
          label="voice"
          value={String(persona["voice"] ?? "")}
          rows={2}
          onChange={(v) => {
            persona["voice"] = v;
            onChange();
          }}
        />
        <TextField
          label="wants"
          value={String(persona["wants"] ?? "")}
          rows={2}
          onChange={(v) => {
            persona["wants"] = v;
            onChange();
          }}
        />
        <LineListField
          label="taboos（每行一条）"
          value={persona["taboos"]}
          onChange={(v) => {
            persona["taboos"] = v;
            onChange();
          }}
        />
        <CommaField
          label="knowledge_tags"
          value={persona["knowledge_tags"]}
          onChange={(v) => {
            persona["knowledge_tags"] = v;
            onChange();
          }}
        />
      </Section>

      <Section title="Lore（模型唯一的事实来源 §7.2）">
        <TextField
          label="lore"
          value={String(entity["lore"] ?? "")}
          rows={10}
          onChange={(v) => {
            entity["lore"] = v;
            onChange();
          }}
        />
      </Section>

      <Section title="LLM 允许清单（安全边界 §5.1）">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="temperature">
            <Input
              type="number"
              step="any"
              value={String(llm["temperature"] ?? 0.85)}
              onChange={(event) => {
                llm["temperature"] = Number(event.target.value);
                onChange();
              }}
            />
          </Field>
          <Field label="max_tokens">
            <Input
              type="number"
              step="1"
              value={String(llm["max_tokens"] ?? 320)}
              onChange={(event) => {
                llm["max_tokens"] = Number(event.target.value);
                onChange();
              }}
            />
          </Field>
        </div>
        <CheckboxGroup
          label="actions_allowed"
          options={ACTION_OPTIONS}
          value={llm["actions_allowed"]}
          onChange={(v) => {
            llm["actions_allowed"] = v;
            onChange();
          }}
        />
        <CommaField
          label="items_may_give"
          value={llm["items_may_give"]}
          onChange={(v) => {
            llm["items_may_give"] = v;
            onChange();
          }}
        />
        <CommaField
          label="flags_may_set"
          value={llm["flags_may_set"]}
          onChange={(v) => {
            llm["flags_may_set"] = v;
            onChange();
          }}
        />
      </Section>

      <Section title="Secrets（reveal_if 决定何时可讲）">
        <JsonField
          label="secrets（JSON 数组）"
          value={entity["secrets"]}
          onChange={(v) => {
            entity["secrets"] = v;
            onChange();
          }}
        />
      </Section>

      <Section title="Scripted fallback（离线保底 §7.4）">
        <LocaleTabs
          label="greeting"
          value={fallback["greeting"]}
          onChange={(next) => {
            fallback["greeting"] = next;
            onChange();
          }}
        />
        <JsonField
          label="lines（JSON 数组；条目为三语文本或 {text, requires, actions}）"
          value={fallback["lines"]}
          onChange={(v) => {
            fallback["lines"] = v;
            onChange();
          }}
        />
        <LocaleTabs
          label="exit"
          value={fallback["exit"]}
          onChange={(next) => {
            fallback["exit"] = next;
            onChange();
          }}
        />
      </Section>

      <Section title="Trigger / Sprite">
        <Field label="trigger.location">
          <Input
            value={String(trigger["location"] ?? "")}
            onChange={(event) => {
              trigger["location"] = event.target.value || null;
              onChange();
            }}
          />
        </Field>
        <JsonField
          label="trigger.requires（JSON 条件或 null）"
          value={trigger["requires"]}
          rows={6}
          onChange={(v) => {
            trigger["requires"] = v;
            onChange();
          }}
        />
        <ArtBlock entity={entity} onChange={onChange} />
      </Section>
    </div>
  );
}

/* ---------- layout primitives ---------- */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/* ---------- controls ---------- */

/**
 * One tab per locale, with a dot that reflects whether that locale is filled in.
 *
 * `missingLocales` drives the summary badge, so what an author sees here is the same verdict
 * the publish gate reaches — the form cannot claim completeness that validation would reject.
 */
function LocaleTabs({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (next: Record<string, string>) => void;
}) {
  const table = asObject(value) as Record<string, string>;
  const missing = missingLocales(table);

  const write = (locale: string, text: string) => {
    onChange({ ...table, [locale]: text });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        {missing.length === 0 ? (
          <span className="text-[10px] text-emerald-500">三语齐备</span>
        ) : (
          <span className="text-[10px] text-amber-500">缺 {missing.join(" / ")}</span>
        )}
      </div>
      <Tabs defaultValue="zh_HK">
        <TabsList>
          {LOCALES.map((locale) => (
            <TabsTrigger key={locale} value={locale} className="gap-1.5 text-xs">
              {locale}
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  String(table[locale] ?? "").trim() ? "bg-emerald-500" : "bg-amber-500/70",
                )}
              />
            </TabsTrigger>
          ))}
        </TabsList>
        {LOCALES.map((locale) => (
          <TabsContent key={locale} value={locale} className="space-y-1">
            <Textarea
              rows={3}
              value={String(table[locale] ?? "")}
              onChange={(event) => write(locale, event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">{LOCALE_HINTS[locale]}</p>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function TextField({
  label,
  value,
  rows,
  onChange,
}: {
  label: string;
  value: string;
  rows: number;
  onChange: (next: string) => void;
}) {
  return (
    <Field label={label}>
      <Textarea rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function CommaField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (next: string[]) => void;
}) {
  const list = Array.isArray(value) ? (value as string[]) : [];
  return (
    <Field label={label}>
      <Input
        value={list.join(", ")}
        onChange={(event) =>
          onChange(
            event.target.value
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean),
          )
        }
      />
    </Field>
  );
}

function LineListField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (next: string[]) => void;
}) {
  const list = Array.isArray(value) ? (value as string[]) : [];
  return (
    <Field label={label}>
      <Textarea
        rows={4}
        value={list.join("\n")}
        onChange={(event) =>
          onChange(
            event.target.value
              .split("\n")
              .map((entry) => entry.trim())
              .filter(Boolean),
          )
        }
      />
    </Field>
  );
}

function CheckboxGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: unknown;
  onChange: (next: string[]) => void;
}) {
  const current = new Set(Array.isArray(value) ? (value as string[]) : []);
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {options.map((option) => (
          <label key={option} className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={current.has(option)}
              onCheckedChange={(checked) => {
                const next = new Set(current);
                if (checked === true) next.add(option);
                else next.delete(option);
                onChange([...next]);
              }}
            />
            {option}
          </label>
        ))}
      </div>
    </Field>
  );
}

/**
 * JSON editor that reports its own parse error instead of silently swallowing it.
 *
 * The DOM version only toggled a CSS class, so an author saw a red border with no reason.
 * Invalid text is never committed, which is what keeps a half-typed object out of the draft.
 */
function JsonField({
  label,
  value,
  rows = 8,
  onChange,
}: {
  label: string;
  value: unknown;
  rows?: number;
  onChange: (next: unknown) => void;
}) {
  // Mounted with key={draftKey}, so this initialisation only has to be right once per draft.
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [error, setError] = useState<string | null>(null);

  return (
    <Field label={label}>
      <Textarea
        rows={rows}
        spellCheck={false}
        value={text}
        className={cn(
          "font-mono text-xs",
          error && "border-destructive focus-visible:ring-destructive/40",
        )}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            onChange(JSON.parse(next));
            setError(null);
          } catch (parseError) {
            setError((parseError as Error).message);
          }
        }}
      />
      {error ? <p className="text-[11px] text-destructive">JSON 无效：{error}</p> : null}
    </Field>
  );
}

/* ---------- art ---------- */

function ArtBlock({ entity, onChange }: { entity: Entity; onChange: () => void }) {
  const [kind, setKind] = useState("sprite");
  const [desc, setDesc] = useState("");
  const [useBible, setUseBible] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const existing = asObject(entity["sprite"])["sheet"];
  const [preview, setPreview] = useState<string | null>(
    typeof existing === "string" && existing ? `/v1/content/file/${existing}` : null,
  );

  async function generate() {
    const subject = desc.trim();
    if (!subject) {
      setNote({ tone: "err", text: "需要描述 / desc required" });
      return;
    }
    setBusy(true);
    setNote({ tone: "ok", text: "生成中… / generating…" });
    try {
      const result = (await api.generateArt({
        kind,
        subject_id: String(entity["id"]),
        desc: subject,
        use_style_bible: useBible,
      })) as Entity;
      const path = String(result["path"]);
      applyArtPath(entity, kind, path);
      setPreview(`data:image/png;base64,${String(result["png_base64"])}`);
      setNote({
        tone: "ok",
        text: `已写入 ${path} · cost $${result["cost_usd"]} · seed ${result["seed"]} — 记得 Save 草稿`,
      });
      onChange();
    } catch (error) {
      const text =
        error instanceof ApiError
          ? `${error.message}: ${
              typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail)
            }`
          : String(error);
      setNote({ tone: "err", text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <Label className="text-xs text-muted-foreground">Art（Seedream §8）</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} onValueChange={(next) => setKind(next ?? "sprite")}>
          <SelectTrigger className="h-8 w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sprite">sprite</SelectItem>
            <SelectItem value="portrait">portrait</SelectItem>
            <SelectItem value="prop">prop</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="h-8 flex-1"
          placeholder="subject description for Seedream (English works best)"
          value={desc}
          onChange={(event) => setDesc(event.target.value)}
        />
        <label
          className="flex items-center gap-1.5 text-xs"
          title="art/stylebible.png 存在时作为 input_references[0] 随每次生成（§8.2）"
        >
          <Checkbox checked={useBible} onCheckedChange={(c) => setUseBible(c === true)} />
          风格基准
        </label>
        <Button size="sm" onClick={() => void generate()} disabled={busy}>
          生成 Generate
        </Button>
      </div>
      {preview ? (
        <img
          src={preview}
          alt="generated art preview"
          className="max-h-40 rounded border [image-rendering:pixelated]"
        />
      ) : null}
      {note ? (
        <p className={cn("text-[11px]", note.tone === "ok" ? "text-muted-foreground" : "text-destructive")}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}
