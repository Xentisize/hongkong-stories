/* Quests view (PLAN §5.4/§9.2): the arcs a player actually walks.
 *
 * A quest is a chain — `nodes[0]` starts it, each node names its `next`, and a node nothing links
 * to is unreachable (which the gate refuses). So the structural edits live in `lib/questDoc.ts`
 * and every button here goes through it: add links the tail, delete repoints the predecessors,
 * rename repoints the references, and "relink" is the only thing that rewrites the chain from the
 * visible order. Reordering rows never touches `next`, so a branched arc survives a tidy-up.
 *
 * What stays out of the form is conditions and effects — JSON, shown with its parse error and
 * never written while it is invalid, the same bargain the chapters view makes for `requires`.
 */

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, ApiError } from "@/api";
import { JsonField } from "@/components/JsonField";
import { LocaleGap } from "@/components/LocaleGap";
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
import { asLocalized, writeLocale, type LocalizedTable } from "@/lib/localized";
import { queryKeys, useEntityIds } from "@/lib/queries";
import {
  NODE_TYPES,
  appendNode,
  blankQuest,
  moveNode,
  nodeId,
  nodesOf,
  relinkChain,
  removeNode,
  renameNode,
  type QuestDoc,
  type QuestNode,
} from "@/lib/questDoc";
import { cn } from "@/lib/utils";

const LOCALES = ["zh_HK", "zh_CN", "en"] as const;
const LOCALE_LABELS: Record<string, string> = { zh_HK: "繁 HK", zh_CN: "简 CN", en: "EN" };
const LOCALE_HINTS: Record<string, string> = {
  zh_HK: "正典口語",
  zh_CN: "書面語，禁粵語虛詞",
  en: "English",
};

interface Issue {
  level: string;
  path: string;
  message: string;
}

/**
 * A node's `text` is one localized block for an objective and an array of them for a cutscene
 * (one per dialogue box). Reading through this keeps every edit branch-free, and an empty
 * objective reads as one blank block rather than as nothing at all.
 */
function pagesOf(text: unknown): LocalizedTable[] {
  if (Array.isArray(text)) return text.map((page) => asLocalized(page));
  return [asLocalized(text)];
}

export function QuestsView({ token }: { token: string }) {
  const client = useQueryClient();
  const questIds = useEntityIds(token, "quests");

  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<QuestDoc | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (selected === null && questIds.data && questIds.data.length > 0) {
      setSelected(questIds.data[0]!);
    }
  }, [questIds.data, selected]);

  const load = useCallback(async (id: string) => {
    setBusy(true);
    try {
      setDoc((await api.getDraft("quests", id)) as QuestDoc);
      setHasDraft(true);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) toast.error(describeError(error));
      try {
        setDoc((await api.entity("quests", id)) as QuestDoc);
      } catch (inner) {
        if (!(inner instanceof ApiError) || inner.status !== 404) toast.error(describeError(inner));
        setDoc(null);
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

  /** Replace the whole document — for the structural edits that return a new chain. */
  const apply = (next: QuestDoc) => {
    setDoc(next);
    setDirty(true);
  };

  const edit = (mutate: (next: QuestDoc) => void) => {
    setDoc((current) => {
      if (current === null) return current;
      const next = structuredClone(current);
      mutate(next);
      return next;
    });
    setDirty(true);
  };

  const setNode = (index: number, mutate: (node: QuestNode) => void) =>
    edit((next) => {
      const node = nodesOf(next)[index];
      if (node !== undefined) mutate(node);
    });

  /** Write into one page of one node, keeping the objective/cutscene shape the node declares. */
  const setPage = (index: number, page: number, mutate: (pages: LocalizedTable[]) => void) =>
    setNode(index, (node) => {
      const pages = pagesOf(node.text);
      while (pages.length <= page) pages.push({});
      mutate(pages);
      node.text = node.type === "cutscene" ? pages : (pages[0] ?? {});
    });

  function newQuest() {
    const taken = new Set(questIds.data ?? []);
    let candidate = "q_new";
    for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `q_new${suffix}`;

    setDoc(blankQuest(candidate));
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
      await api.putDraft("quests", id, doc);
      await client.invalidateQueries({ queryKey: queryKeys.drafts(token) });
      setHasDraft(true);
      setIsNew(false);
      setDirty(false);
      setSelected(id);
      toast.success(`已保存草稿 / draft saved: ${id}`);
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function discard() {
    if (selected === null) return;
    try {
      await api.deleteDraft("quests", selected);
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
      const mine = (report.issues ?? []).filter((issue) => issue.path.startsWith("quests/"));
      setIssues(mine);
      if (mine.length === 0) toast.success("任務冇問題 / quests valid");
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  function addNode() {
    if (doc === null) return;
    apply(appendNode(doc));
  }

  function deleteNode(id: string) {
    if (doc === null) return;
    const next = removeNode(doc, id);
    if (next === null) {
      toast.error("刪唔到：任務至少要有一個節點 / the last node cannot be removed");
      return;
    }
    apply(next);
  }

  function nudge(id: string, delta: number) {
    if (doc === null) return;
    const next = moveNode(doc, id, delta);
    if (next !== doc) apply(next);
  }

  function rename(from: string, to: string): boolean {
    if (doc === null) return false;
    const next = renameNode(doc, from, to);
    if (next === null) return false;
    apply(next);
    return true;
  }

  const nodes = nodesOf(doc);
  const nodeIds = nodes.map(nodeId);

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <Card className="h-fit">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">任務 Quests</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button size="sm" variant="outline" className="w-full" onClick={newQuest}>
            新任務 New quest
          </Button>
          {questIds.isPending ? (
            <p className="text-xs text-muted-foreground">加载中…</p>
          ) : (
            <ScrollArea className="max-h-[26rem]">
              <div className="space-y-1 pr-2">
                {(questIds.data ?? []).map((id) => (
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
            {busy ? "加载中…" : "揀一個任務，或者開新一個 / pick a quest, or start a new one"}
          </p>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">ID</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {isNew ? (
                  <Input
                    className="h-8 font-mono text-xs"
                    value={String(doc.id ?? "")}
                    onChange={(event) => edit((next) => void (next.id = event.target.value))}
                  />
                ) : (
                  <p className="font-mono text-xs text-muted-foreground">{String(doc.id ?? "")}</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  標題 Title
                  <LocaleGap field={doc.title} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-2">
                  {LOCALES.map((locale) => (
                    <div key={locale} className="space-y-1">
                      <span className="text-[10px] text-muted-foreground">{LOCALE_LABELS[locale]}</span>
                      <Input
                        className="h-8 text-xs"
                        value={asLocalized(doc.title)[locale] ?? ""}
                        onChange={(event) =>
                          edit((next) => {
                            next.title = writeLocale(next.title, locale, event.target.value);
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
                <CardTitle className="text-sm">入場條件 Entry requires</CardTitle>
              </CardHeader>
              <CardContent>
                <JsonField
                  label="entry_requires"
                  value={doc.entry_requires}
                  rows={4}
                  hint="§5.5 條件 JSON；null 表示隨時可接 / null means the quest can start at any time"
                  onChange={(next) => edit((current) => void (current.entry_requires = next))}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center gap-2 pb-2">
                <CardTitle className="text-sm">節點 Nodes（{nodes.length}）</CardTitle>
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="outline" onClick={addNode}>
                    追加節點 Add
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    title="令 next 跟住下面嘅次序 / make the visible order the chain"
                    onClick={() => doc !== null && apply(relinkChain(doc))}
                  >
                    依序連結 Relink
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {nodes.map((node, index) => {
                  const id = nodeId(node);
                  const type = node.type === "cutscene" ? "cutscene" : "objective";
                  const pages = pagesOf(node.text);
                  const nextValue = typeof node.next === "string" && node.next !== "" ? node.next : "end";

                  return (
                    <div key={`${id}-${index}`} className="space-y-3 rounded-md border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] text-muted-foreground">#{index + 1}</span>
                        <NodeIdField id={id} onRename={(to) => rename(id, to)} />
                        <Select
                          value={type}
                          onValueChange={(value) =>
                            setNode(index, (current) => {
                              const blocks = pagesOf(current.text);
                              current.type = value ?? "objective";
                              current.text = current.type === "cutscene" ? blocks : (blocks[0] ?? {});
                            })
                          }
                        >
                          <SelectTrigger className="h-7 w-28 text-[11px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {NODE_TYPES.map((entry) => (
                              <SelectItem key={entry} value={entry} className="text-xs">
                                {entry}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <Select
                          value={nextValue}
                          onValueChange={(value) =>
                            setNode(index, (current) => {
                              current.next = value === "end" || value === null ? null : value;
                            })
                          }
                        >
                          <SelectTrigger className="h-7 w-32 text-[11px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="end" className="text-xs">
                              （接落尾 end）
                            </SelectItem>
                            {nodeIds
                              .filter((candidate) => candidate !== id)
                              .map((candidate) => (
                                <SelectItem key={candidate} value={candidate} className="text-xs">
                                  {candidate}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>

                        <div className="ml-auto flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={index === 0}
                            title="上移 Up"
                            onClick={() => nudge(id, -1)}
                          >
                            ↑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={index === nodes.length - 1}
                            title="下移 Down"
                            onClick={() => nudge(id, 1)}
                          >
                            ↓
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={nodes.length <= 1}
                            title="刪除 Delete"
                            onClick={() => deleteNode(id)}
                          >
                            ✕
                          </Button>
                        </div>
                      </div>

                      {type === "objective" ? (
                        <div className="space-y-1">
                          <div className="text-[10px] text-muted-foreground">
                            目標文字 Objective
                            <LocaleGap field={node.text} />
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            {LOCALES.map((locale) => (
                              <Input
                                key={locale}
                                className="h-8 text-xs"
                                placeholder={LOCALE_LABELS[locale]}
                                value={asLocalized(pages[0])[locale] ?? ""}
                                onChange={(event) =>
                                  setPage(index, 0, (blocks) => {
                                    blocks[0] = writeLocale(blocks[0], locale, event.target.value);
                                  })
                                }
                              />
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="text-[10px] text-muted-foreground">
                            對白頁 Cutscene pages（每頁一個對話框 / one dialogue box per page）
                          </div>
                          {pages.map((page, pageIndex) => (
                            <div key={pageIndex} className="space-y-1 rounded border p-2">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-muted-foreground">
                                  第 {pageIndex + 1} 頁
                                </span>
                                <div className="ml-auto flex gap-1">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={pageIndex === 0}
                                    onClick={() =>
                                      setPage(index, pageIndex, (blocks) => {
                                        if (pageIndex > 0) {
                                          const [moved] = blocks.splice(pageIndex, 1);
                                          blocks.splice(pageIndex - 1, 0, moved ?? {});
                                        }
                                      })
                                    }
                                  >
                                    ↑
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={pages.length <= 1}
                                    onClick={() =>
                                      setPage(index, pageIndex, (blocks) => {
                                        if (blocks.length > 1) blocks.splice(pageIndex, 1);
                                      })
                                    }
                                  >
                                    ✕
                                  </Button>
                                </div>
                              </div>
                              <div className="grid grid-cols-3 gap-2">
                                {LOCALES.map((locale) => (
                                  <Textarea
                                    key={locale}
                                    rows={2}
                                    className="text-xs"
                                    placeholder={`${LOCALE_LABELS[locale]} · ${LOCALE_HINTS[locale]}`}
                                    value={asLocalized(page)[locale] ?? ""}
                                    onChange={(event) =>
                                      setPage(index, pageIndex, (blocks) => {
                                        blocks[pageIndex] = writeLocale(
                                          blocks[pageIndex],
                                          locale,
                                          event.target.value,
                                        );
                                      })
                                    }
                                  />
                                ))}
                              </div>
                            </div>
                          ))}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setPage(index, pages.length, (blocks) => {
                                blocks.push({});
                              })
                            }
                          >
                            加一頁 Add page
                          </Button>
                        </div>
                      )}

                      <div className="grid gap-3 sm:grid-cols-2">
                        <JsonField
                          key={`${id}-complete`}
                          label="完成條件 complete_when"
                          value={node.complete_when}
                          rows={5}
                          hint="§5.5 條件 JSON；null 表示冇（過場用）/ null for a cutscene"
                          onChange={(next) => setNode(index, (current) => void (current.complete_when = next))}
                        />
                        <JsonField
                          key={`${id}-effects`}
                          label="完成時 on_complete"
                          value={node.on_complete}
                          rows={5}
                          hint="§5.5 effect 陣列 / array of effects"
                          onChange={(next) => setNode(index, (current) => void (current.on_complete = next))}
                        />
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The node id, committed on blur.
 *
 * Committing rather than binding directly is what makes a rename safe: every keystroke would
 * otherwise be a new id, and half of them would collide with a node that already answers to it.
 */
function NodeIdField({ id, onRename }: { id: string; onRename: (next: string) => boolean }) {
  return (
    <Input
      key={id}
      defaultValue={id}
      title="節點 id — Enter 或離開欄位才寫入 / committed on blur"
      className="h-7 w-28 font-mono text-[11px]"
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.currentTarget.value = id;
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        const next = event.target.value.trim();
        if (next === id) return;
        if (!onRename(next)) {
          event.target.value = id;
          toast.error("節點 id 空白、重複或無效 / blank, duplicate or unknown node id");
        }
      }}
    />
  );
}
