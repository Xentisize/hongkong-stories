/* Chapters view (PLAN §5.4/§12): the aggregation document a creator actually authors.
 *
 * A chapter is references — which maps it spans, which quest carries it, where a new arrival lands,
 * and what unlocks the next one. So this view never asks for an id to be typed: locations, quests and
 * transition targets are picked from what the pack contains. That is the whole point of the format,
 * and it is why the validator's referential rules can be strict without being annoying.
 *
 * The `requires` on a transition is JSON in a textarea rather than a rule builder: the Builder view
 * owns that vocabulary, and duplicating half of it here would give creators two editors that drift.
 * Invalid JSON is shown but not written, so a half-typed condition never lands in a draft.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, ApiError } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { queryKeys, useEntityIds, type Entity } from "@/lib/queries";

const LOCALES = ["zh_HK", "zh_CN", "en"] as const;
const LOCALE_LABELS: Record<string, string> = { zh_HK: "繁 HK", zh_CN: "简 CN", en: "EN" };

type Localized = Record<string, string>;

interface Transition {
  to?: string;
  requires?: unknown;
  text?: Localized;
}

interface ChapterDoc {
  schema_version?: number;
  id?: string;
  title?: Localized;
  quests?: string[];
  locations?: string[];
  entry?: { location?: string; spawn?: string; requires?: unknown };
  transitions?: Transition[];
  [field: string]: unknown;
}

interface Issue {
  level: string;
  path: string;
  message: string;
}

export function ChaptersView({ token }: { token: string }) {
  const client = useQueryClient();
  const chapterIds = useEntityIds(token, "chapters");
  const questIds = useEntityIds(token, "quests");
  const locationIds = useEntityIds(token, "locations");

  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<ChapterDoc | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [requiresText, setRequiresText] = useState<Record<number, string>>({});

  // A chapter is picked once the list arrives, so the view opens on something rather than blank.
  useEffect(() => {
    if (selected === null && chapterIds.data && chapterIds.data.length > 0) {
      setSelected(chapterIds.data[0]!);
    }
  }, [chapterIds.data, selected]);

  const load = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const draft = (await api.getDraft("chapters", id)) as ChapterDoc;
      setDoc(draft);
      setHasDraft(true);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) toast.error(describeError(error));
      try {
        setDoc((await api.entity("chapters", id)) as ChapterDoc);
      } catch (inner) {
        if (!(inner instanceof ApiError) || inner.status !== 404) toast.error(describeError(inner));
        setDoc(null);
      }
      setHasDraft(false);
    } finally {
      setBusy(false);
      setDirty(false);
      setRequiresText({});
    }
  }, []);

  useEffect(() => {
    if (selected !== null) void load(selected);
  }, [selected, load]);

  // The entry's spawn list comes from the location itself, so a creator picks a real point.
  const entryLocation = useQuery({
    queryKey: ["entity", token, "locations", doc?.entry?.location ?? ""] as const,
    enabled: Boolean(doc?.entry?.location),
    queryFn: () => api.entity("locations", String(doc?.entry?.location)) as Promise<Entity>,
  });

  const spawnOptions = useMemo(() => {
    const points = entryLocation.data?.["spawn_points"];
    return points && typeof points === "object" && !Array.isArray(points)
      ? Object.keys(points as Record<string, unknown>).sort()
      : [];
  }, [entryLocation.data]);

  const edit = (mutate: (next: ChapterDoc) => void) => {
    setDoc((current) => {
      if (current === null) return current;
      const next = structuredClone(current);
      mutate(next);
      return next;
    });
    setDirty(true);
  };

  async function save() {
    if (doc === null || selected === null) return;

    try {
      await api.putDraft("chapters", selected, doc);
      await client.invalidateQueries({ queryKey: queryKeys.drafts(token) });
      setHasDraft(true);
      setDirty(false);
      toast.success("已保存草稿 / draft saved");
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function discard() {
    if (selected === null) return;

    try {
      await api.deleteDraft("chapters", selected);
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
      const mine = (report.issues ?? []).filter((issue) => issue.path.startsWith("chapters/"));
      setIssues(mine);
      if (mine.length === 0) toast.success("章節冇問題 / chapters valid");
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  const chapterList = chapterIds.data ?? [];
  const locationsInDoc = doc?.locations ?? [];
  const entrySpawn = doc?.entry?.spawn ?? "default";

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <Card className="h-fit">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">章節 Chapters</CardTitle>
        </CardHeader>
        <CardContent>
          {chapterIds.isPending ? (
            <p className="text-xs text-muted-foreground">加载中…</p>
          ) : chapterList.length === 0 ? (
            <p className="text-xs text-muted-foreground">（冇章節 / no chapters）</p>
          ) : (
            <ScrollArea className="max-h-[28rem]">
              <div className="space-y-1 pr-2">
                {chapterList.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSelected(id)}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs ${
                      selected === id ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                    }`}
                  >
                    <span className="font-mono">{id}</span>
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
          <Badge variant={hasDraft ? "default" : "outline"} className="text-[10px]">
            {hasDraft ? "草稿 Draft" : "基準 Baseline"}
          </Badge>
          {dirty ? (
            <Badge variant="secondary" className="text-[10px]">
              未保存 Unsaved
            </Badge>
          ) : null}
          <Button size="sm" disabled={!dirty} onClick={() => void save()}>
            保存草稿 Save
          </Button>
          <Button size="sm" variant="outline" disabled={!hasDraft} onClick={() => void discard()}>
            掉棄草稿 Discard
          </Button>
          <Button size="sm" variant="outline" onClick={() => void validate()}>
            驗證 Validate
          </Button>
        </div>

        {issues.length > 0 ? (
          <Card className="border-destructive/40">
            <CardContent className="space-y-1 pt-4">
              {issues.map((issue) => (
                <p key={`${issue.path}-${issue.message}`} className="font-mono text-[11px] text-destructive">
                  [{issue.level}] {issue.path}: {issue.message}
                </p>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {doc === null ? (
          <p className="text-xs text-muted-foreground">
            {busy ? "加载中…" : "揀一個章節 / pick a chapter"}
          </p>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">標題 Title</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-2">
                  {LOCALES.map((locale) => (
                    <div key={locale} className="space-y-1">
                      <span className="text-[10px] text-muted-foreground">{LOCALE_LABELS[locale]}</span>
                      <Input
                        className="h-8 text-xs"
                        value={doc.title?.[locale] ?? ""}
                        onChange={(event) =>
                          edit((next) => {
                            next.title = { ...(next.title ?? {}), [locale]: event.target.value };
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
                <CardTitle className="text-sm">範圍 Scope</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1">
                  <Label className="text-xs">地圖 Locations</Label>
                  <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto rounded border border-border/60 p-2">
                    {(locationIds.data ?? []).map((id) => {
                      const checked = locationsInDoc.includes(id);
                      return (
                        <label key={id} className="flex items-center gap-2 font-mono text-[11px]">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              edit((next) => {
                                const current = next.locations ?? [];
                                next.locations = checked
                                  ? current.filter((entry) => entry !== id)
                                  : [...current, id];
                                // The entry must stay inside the chapter, so dropping the entry
                                // location clears it rather than leaving an invalid draft behind.
                                if (checked && next.entry?.location === id) next.entry.location = "";
                              })
                            }
                          />
                          {id}
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">任務 Quests</Label>
                  <div className="grid max-h-32 grid-cols-2 gap-1 overflow-y-auto rounded border border-border/60 p-2">
                    {(questIds.data ?? []).map((id) => {
                      const checked = (doc.quests ?? []).includes(id);
                      return (
                        <label key={id} className="flex items-center gap-2 font-mono text-[11px]">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              edit((next) => {
                                const current = next.quests ?? [];
                                next.quests = checked
                                  ? current.filter((entry) => entry !== id)
                                  : [...current, id];
                              })
                            }
                          />
                          {id}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">起點 Entry</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">地點 Location</Label>
                  <Select
                    value={doc.entry?.location === "" ? undefined : doc.entry?.location}
                    onValueChange={(value) => {
                      if (value === null) return;
                      edit((next) => {
                        next.entry = { ...(next.entry ?? {}), location: value };
                      });
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="選擇本章地圖…" />
                    </SelectTrigger>
                    <SelectContent>
                      {locationsInDoc.map((id) => (
                        <SelectItem key={id} value={id}>
                          {id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">
                    只可以揀本章已勾選嘅地圖 / only maps listed above
                  </p>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">出生點 Spawn</Label>
                  <Select
                    value={entrySpawn}
                    onValueChange={(value) => {
                      if (value === null) return;
                      edit((next) => {
                        next.entry = { ...(next.entry ?? {}), spawn: value };
                      });
                    }}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(spawnOptions.length > 0 ? spawnOptions : ["default"]).map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm">去向 Transitions</CardTitle>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    edit((next) => {
                      next.transitions = [...(next.transitions ?? []), { to: "" }];
                    })
                  }
                >
                  加一條 Add
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                {(doc.transitions ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">（結局章節無去向 / terminal chapter）</p>
                ) : (
                  (doc.transitions ?? []).map((transition, index) => {
                    const text = requiresText[index] ?? JSON.stringify(transition.requires ?? null, null, 2);
                    let parses = true;
                    try {
                      JSON.parse(text);
                    } catch {
                      parses = false;
                    }

                    return (
                      <div key={index} className="space-y-2 rounded border border-border/60 p-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <Label className="text-xs">下一章 Next chapter</Label>
                            <Select
                              value={transition.to === "" ? undefined : transition.to}
                              onValueChange={(value) => {
                                if (value === null) return;
                                edit((next) => {
                                  const row = next.transitions?.[index];
                                  if (row) row.to = value;
                                });
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue placeholder="選擇章節…" />
                              </SelectTrigger>
                              <SelectContent>
                                {chapterList
                                  .filter((id) => id !== selected)
                                  .map((id) => (
                                    <SelectItem key={id} value={id}>
                                      {id}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="flex items-end">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive"
                              onClick={() =>
                                edit((next) => {
                                  next.transitions = (next.transitions ?? []).filter(
                                    (_, at) => at !== index,
                                  );
                                })
                              }
                            >
                              刪除 Remove
                            </Button>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs">
                            條件 Requires（§5.5 JSON）
                            {!parses ? (
                              <span className="ml-2 text-destructive">JSON 未完整 / invalid JSON</span>
                            ) : null}
                          </Label>
                          <Textarea
                            className="min-h-16 font-mono text-[11px]"
                            value={text}
                            onChange={(event) => {
                              const raw = event.target.value;
                              setRequiresText((current) => ({ ...current, [index]: raw }));

                              // Only a complete condition reaches the draft: a half-typed one would
                              // fail the gate and hide the chapter behind an error.
                              try {
                                const parsed = JSON.parse(raw) as unknown;
                                edit((next) => {
                                  const row = next.transitions?.[index];
                                  if (row) {
                                    if (parsed === null) delete row.requires;
                                    else row.requires = parsed;
                                  }
                                });
                              } catch {
                                /* keep the text, leave the draft alone */
                              }
                            }}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
