/* Items view (PLAN §5.2/§9.2): what the bag, the shops and the effects read.
 *
 * The basics are a form — a name and a description in three locales, an icon, a stack size, a
 * category. What cannot be a form (effects, use conditions) is JSON in a textarea that refuses to
 * write what it cannot parse, the same bargain the chapters view makes for `requires`.
 *
 * Two things are picked rather than typed, because they are the references the validator will
 * refuse if they are wrong: the icon (the art that actually ships in the pack) and the lore file
 * (the markdown the bag's detail pane links to).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, ApiError } from "@/api";
import { InheritanceField } from "@/components/InheritanceField";
import { JsonField } from "@/components/JsonField";
import { LocaleGap } from "@/components/LocaleGap";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { describeError } from "@/lib/errors";
import { asLocalized, writeLocale, type LocalizedTable } from "@/lib/localized";
import { queryKeys, useEntityIds, type Entity } from "@/lib/queries";
import { useUndoable, useUndoKeys } from "@/lib/undo";
import { cn } from "@/lib/utils";

/** Every item sprite that ships: the picker's list, not a closed set (art may land first). */
const ICONS = Object.keys(
  import.meta.glob("../../../client/content/art/items/*.png", { eager: true, query: "?url" }),
)
  .map((entry) => `res://content/art/items/${entry.split("/").pop() ?? ""}`)
  .sort();

const LORE = Object.keys(
  import.meta.glob("../../../client/content/lore/*.md", { eager: true, query: "?url" }),
)
  .map((entry) => `lore/${entry.split("/").pop() ?? ""}`)
  .sort();

const LOCALES = ["zh_HK", "zh_CN", "en"] as const;
const LOCALE_LABELS: Record<string, string> = { zh_HK: "繁 HK", zh_CN: "簡 CN", en: "EN" };
const LOCALE_HINTS: Record<string, string> = {
  zh_HK: "正典口語",
  zh_CN: "書面語，禁粵語虛詞",
  en: "English",
};

const CATEGORIES = ["keepsake", "key", "quest", "consumable", "misc"];

interface ItemDoc {
  schema_version?: number;
  id?: string;
  icon?: string;
  name?: LocalizedTable;
  desc?: LocalizedTable;
  /** Shown instead of `desc` while `use_requires` refuses the use. */
  use_locked?: LocalizedTable;
  stack_max?: number;
  category?: string;
  usable?: boolean;
  use_requires?: unknown;
  on_use?: unknown;
  on_acquire?: unknown;
  lore_ref?: string;
  [field: string]: unknown;
}

interface Issue {
  level: string;
  path: string;
  message: string;
}

/** A Godot resource path is two different HTTP routes depending on where the file lives. */
function previewSrc(path: string): string | null {
  if (path.startsWith("res://content/")) return `/v1/content/file/${path.slice("res://content/".length)}`;
  if (path.startsWith("res://assets/")) return `/v1/assets/file/${path.slice("res://assets/".length)}`;
  if (path.startsWith("art/")) return `/v1/content/file/${path}`;
  return null;
}

export function ItemsView({ token }: { token: string }) {
  const client = useQueryClient();
  const itemIds = useEntityIds(token, "items");

  const [selected, setSelected] = useState<string | null>(null);
  // The draft is a document with a history: a mistyped field is now one ⌘Z, not a retype.
  const undoable = useUndoable<ItemDoc>(null);
  const doc = undoable.doc;
  useUndoKeys(undoable.undo, undoable.redo);
  const [hasDraft, setHasDraft] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (selected === null && itemIds.data && itemIds.data.length > 0) {
      setSelected(itemIds.data[0]!);
    }
  }, [itemIds.data, selected]);

  const load = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const draft = (await api.getDraft("items", id)) as ItemDoc;
      undoable.load(draft);
      setHasDraft(true);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) toast.error(describeError(error));
      try {
        undoable.load((await api.entity("items", id)) as ItemDoc);
      } catch (inner) {
        if (!(inner instanceof ApiError) || inner.status !== 404) toast.error(describeError(inner));
        undoable.load(null);
      }
      setHasDraft(false);
    } finally {
      setBusy(false);
      setDirty(false);
      setIsNew(false);
    }
  }, []);

  useEffect(() => {
    if (selected !== null) void load(selected);
  }, [selected, load]);

  const edit = (mutate: (next: ItemDoc) => void) => {
    if (doc === null) return;
    const next = structuredClone(doc);
    mutate(next);
    // Coalesced: a form edit arrives once per keystroke, and one character per undo step is an
    // undo nobody would use.
    undoable.set(next, { coalesce: true });
    setDirty(true);
  };

  /** A wholesale replacement — the inheritance picker re-points the whole document at a parent. */
  const applyDoc = (next: ItemDoc) => {
    undoable.set(next);
    setDirty(true);
  };

  /** A free `item_…` id, so "new" never collides with what the pack already ships. */
  function newItem() {
    const taken = new Set(itemIds.data ?? []);
    let candidate = "item_new";
    for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `item_new${suffix}`;

    undoable.load({
      schema_version: 1,
      id: candidate,
      icon: "",
      name: {},
      desc: {},
      stack_max: 1,
      category: "keepsake",
      usable: false,
      use_requires: null,
      on_use: [],
      on_acquire: [],
      lore_ref: "",
    });
    setSelected(null);
    setIsNew(true);
    setHasDraft(false);
    setDirty(true);
    setIssues([]);
  }

  async function save() {
    if (doc === null) return;
    const id = String(doc.id ?? "").trim();
    if (id === "") {
      toast.error("需要 id / an id is required");
      return;
    }

    try {
      await api.putDraft("items", id, doc);
      await client.invalidateQueries({ queryKey: queryKeys.drafts(token) });
      setHasDraft(true);
      setIsNew(false);
      setDirty(false);
      setSelected(id);
      // The saved draft is the new origin: undo should not walk back past what is on disk.
      undoable.load(doc);
      toast.success(`已保存草稿 / draft saved: ${id}`);
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function discard() {
    if (selected === null) return;
    try {
      await api.deleteDraft("items", selected);
      await client.invalidateQueries({ queryKey: queryKeys.drafts(token) });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) toast.error(describeError(error));
    }
    await load(selected);
    toast.success("已還原至基準 / reverted to baseline");
  }

  async function validate() {
    try {
      const report = (await api.validate()) as { issues?: Issue[] };
      const mine = (report.issues ?? []).filter((issue) => issue.path.startsWith("items/"));
      setIssues(mine);
      if (mine.length === 0) toast.success("物品冇問題 / items valid");
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  const usable = doc?.usable === true;
  const iconPath = typeof doc?.icon === "string" ? doc.icon : "";
  const iconPreview = previewSrc(iconPath);
  const category = doc?.category ?? "";
  const categories = useMemo(
    () => (category !== "" && !CATEGORIES.includes(category) ? [category, ...CATEGORIES] : CATEGORIES),
    [category],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <Card className="h-fit">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">物品 Items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button size="sm" variant="outline" className="w-full" onClick={newItem}>
            新物品 New item
          </Button>
          {itemIds.isPending ? (
            <p className="text-xs text-muted-foreground">加載中…</p>
          ) : (
            <ScrollArea className="max-h-[26rem]">
              <div className="space-y-1 pr-2">
                {(itemIds.data ?? []).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSelected(id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs",
                      selected === id ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                    )}
                  >
                    <span className="truncate font-mono">{id}</span>
                    {selected === id && hasDraft ? (
                      <Badge variant="secondary" className="text-[9px]">
                        草稿
                      </Badge>
                    ) : null}
                  </button>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={isNew ? "outline" : hasDraft ? "default" : "outline"} className="text-[10px]">
            {isNew ? "新 New" : hasDraft ? "草稿 Draft" : "基準 Baseline"}
          </Badge>
          {dirty ? (
            <Badge variant="secondary" className="text-[10px]">
              未保存 Unsaved
            </Badge>
          ) : null}
          <Button size="sm" disabled={!dirty} onClick={() => void save()}>
            保存草稿 Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!hasDraft || isNew}
            onClick={() => void discard()}
          >
            掉棄草稿 Discard
          </Button>
          <Button size="sm" variant="outline" disabled={!undoable.canUndo} title="⌘Z / Ctrl+Z" onClick={undoable.undo}>
            ↶ 復原
          </Button>
          <Button size="sm" variant="outline" disabled={!undoable.canRedo} title="⇧⌘Z / Ctrl+Shift+Z" onClick={undoable.redo}>
            ↷ 重做
          </Button>
          <Button size="sm" variant="outline" onClick={() => void validate()}>
            驗證 Validate
          </Button>
        </div>

        {issues.length > 0 ? (
          <Card className="border-destructive/40">
            <CardContent className="space-y-1 pt-4">
              {issues.map((issue) => (
                <p
                  key={`${issue.path}-${issue.message}`}
                  className="font-mono text-[11px] text-destructive"
                >
                  [{issue.level}] {issue.path}: {issue.message}
                </p>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {doc === null ? (
          <p className="text-xs text-muted-foreground">
            {busy ? "加載中…" : "揀一個物品，或者開新一個 / pick an item, or start a new one"}
          </p>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">基本 Basics</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">ID</Label>
                    {isNew ? (
                      <Input
                        className="h-8 font-mono text-xs"
                        value={String(doc.id ?? "")}
                        onChange={(event) => edit((next) => void (next.id = event.target.value))}
                      />
                    ) : (
                      <p className="font-mono text-xs text-muted-foreground">{String(doc.id ?? "")}</p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">類別 Category</Label>
                    <Select
                      value={category === "" ? "keepsake" : category}
                      onValueChange={(next) =>
                        edit((current) => void (current.category = next ?? "keepsake"))
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map((entry) => (
                          <SelectItem key={entry} value={entry} className="text-xs">
                            {entry}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">堆疊上限 Stack max</Label>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      className="h-8 text-xs"
                      value={Number(doc.stack_max ?? 1)}
                      onChange={(event) =>
                        edit((next) => void (next.stack_max = Number(event.target.value)))
                      }
                    />
                    <p className="text-[10px] text-muted-foreground">
                      0 表示不設上限（運行時用 999）/ 0 means unlimited (999 at runtime)
                    </p>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">典故 Lore file</Label>
                    <Select
                      value={typeof doc.lore_ref === "string" && doc.lore_ref !== "" ? doc.lore_ref : "none"}
                      onValueChange={(next) =>
                        edit((current) => void (current.lore_ref = next === "none" ? "" : (next ?? "")))
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none" className="text-xs">
                          （無 / none）
                        </SelectItem>
                        {LORE.map((entry) => (
                          <SelectItem key={entry} value={entry} className="text-xs">
                            {entry}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <div className="space-y-1">
                    <Label className="text-xs">圖示 Icon</Label>
                    <Input
                      list="hks-item-icons"
                      className="h-8 font-mono text-xs"
                      value={iconPath}
                      placeholder="res://content/art/items/item_tea_tin.png"
                      onChange={(event) => edit((next) => void (next.icon = event.target.value))}
                    />
                    <datalist id="hks-item-icons">
                      {ICONS.map((entry) => (
                        <option key={entry} value={entry} />
                      ))}
                    </datalist>
                  </div>
                  {iconPreview !== null ? (
                    <img
                      src={iconPreview}
                      alt=""
                      className="size-12 rounded border object-contain [image-rendering:pixelated]"
                    />
                  ) : null}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">繼承 Inheritance</CardTitle>
              </CardHeader>
              <CardContent>
                <InheritanceField
                  token={token}
                  kind="items"
                  doc={doc as Entity}
                  onChange={(next) => applyDoc(next as ItemDoc)}
                  title="父文件 Parent"
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  名稱 Name
                  <LocaleGap field={doc.name} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-2">
                  {LOCALES.map((locale) => (
                    <div key={locale} className="space-y-1">
                      <span className="text-[10px] text-muted-foreground">{LOCALE_LABELS[locale]}</span>
                      <Input
                        className="h-8 text-xs"
                        value={asLocalized(doc.name)[locale] ?? ""}
                        onChange={(event) =>
                          edit((next) => {
                            next.name = writeLocale(next.name, locale, event.target.value);
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  描述 Description
                  <LocaleGap field={doc.desc} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-2">
                  {LOCALES.map((locale) => (
                    <div key={locale} className="space-y-1">
                      <span className="text-[10px] text-muted-foreground">
                        {LOCALE_LABELS[locale]} · {LOCALE_HINTS[locale]}
                      </span>
                      <Textarea
                        rows={3}
                        className="text-xs"
                        value={asLocalized(doc.desc)[locale] ?? ""}
                        onChange={(event) =>
                          edit((next) => {
                            next.desc = writeLocale(next.desc, locale, event.target.value);
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm">可用 Usable</CardTitle>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox
                    checked={usable}
                    onCheckedChange={(checked) =>
                      edit((next) => void (next.usable = checked === true))
                    }
                  />
                  可以喺背包用 / use from the bag
                </label>
              </CardHeader>
              {usable ? (
                <CardContent className="space-y-3">
                  <div className="grid gap-2 sm:grid-cols-3">
                    {LOCALES.map((locale) => (
                      <div key={locale} className="space-y-1">
                        <span className="text-[10px] text-muted-foreground">
                          {LOCALE_LABELS[locale]} · 用唔到時嘅話 Use-locked line
                        </span>
                        <Textarea
                          rows={2}
                          className="text-xs"
                          value={asLocalized(doc.use_locked)[locale] ?? ""}
                          onChange={(event) =>
                            edit((next) => {
                              next.use_locked = writeLocale(next.use_locked, locale, event.target.value);
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>

                  <JsonField
                    label="使用條件 use_requires"
                    value={doc.use_requires}
                    rows={5}
                    hint="§5.5 條件 JSON；null 表示隨時可用 / null means always usable"
                    onChange={(next) => edit((current) => void (current.use_requires = next))}
                  />
                </CardContent>
              ) : null}
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">效果 Effects</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <JsonField
                  label="使用時 on_use"
                  value={doc.on_use}
                  rows={7}
                  hint="§5.5 effect 陣列 / array of effects"
                  onChange={(next) => edit((current) => void (current.on_use = next))}
                />
                <JsonField
                  label="取得時 on_acquire"
                  value={doc.on_acquire}
                  rows={7}
                  hint="§5.5 effect 陣列 / array of effects"
                  onChange={(next) => edit((current) => void (current.on_acquire = next))}
                />
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}


export type { ItemDoc };
