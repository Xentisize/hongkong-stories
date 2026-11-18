/* Lore view (PLAN 5.4/9.2): the era pages the facts are allowed to come from.
 *
 * A lore page is markdown, not an entity — one page per era, referenced by name from an item's
 * `lore_ref` and quoted into an NPC's prompt as authored fact. So this view edits text: it keeps a
 * draft beside the pack exactly like the other editors, and publishing copies the page into
 * `content/lore/` verbatim rather than round-tripping it through JSON, which would escape the prose.
 *
 * What this view deliberately does **not** claim: the page is not loaded by either client today. The
 * runtime reads an NPC's inline `lore` field; `lore_ref` names the page for authors and for the
 * fact-check workflow. The banner says so, because an editor that implied otherwise would make a
 * missing wiring look like a content bug.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, ApiError } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { describeError } from "@/lib/errors";
import { queryKeys, useEntityIds } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** A page name is a file name: no separators, nothing that escapes the folder. */
function cleanName(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9_-]/g, "_");
}

export function LoreView({ token }: { token: string }) {
  const client = useQueryClient();
  const loreIds = useEntityIds(token, "lore");

  const [selected, setSelected] = useState<string | null>(null);
  /** The page being created, before it has a draft on disk. */
  const [draftName, setDraftName] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [hasDraft, setHasDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const isNew = draftName !== null;
  const dirty = isNew ? text.trim() !== "" : text !== saved;

  useEffect(() => {
    if (selected === null && !isNew && loreIds.data && loreIds.data.length > 0) {
      setSelected(loreIds.data[0]!);
    }
  }, [loreIds.data, selected, isNew]);

  // Load the selected page: a draft wins over the baseline, because that is what publish ships.
  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;

    void (async () => {
      setBusy(true);
      let body = "";
      let draft = false;
      try {
        try {
          body = await api.loreDraft(selected);
          draft = true;
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
          body = await api.loreBaseline(selected);
        }
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) toast.error(describeError(error));
      }
      if (cancelled) return;
      setText(body);
      setSaved(body);
      setHasDraft(draft);
      setBusy(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [selected]);

  function newPage() {
    const taken = new Set(loreIds.data ?? []);
    let name = "lore_new";
    for (let suffix = 2; taken.has(name); suffix += 1) name = `lore_new${suffix}`;

    setSelected(null);
    setDraftName(name);
    setText(`# ${name}\n\n`);
    setSaved("");
    setHasDraft(false);
  }

  async function save() {
    const target = isNew ? cleanName(draftName ?? "") : (selected ?? "");
    if (target === "") {
      toast.error("需要檔名 / a page name is required");
      return;
    }

    try {
      await api.putLoreDraft(target, text);
      await client.invalidateQueries({ queryKey: queryKeys.drafts(token) });
      await client.invalidateQueries({ queryKey: queryKeys.entities(token, "lore") });
      setHasDraft(true);
      setDraftName(null);
      setSelected(target);
      setSaved(text);
      toast.success(`已保存草稿 / draft saved: ${target}.md`);
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function discard() {
    if (selected === null) return;
    try {
      await api.deleteDraft("lore", selected);
      await client.invalidateQueries({ queryKey: queryKeys.drafts(token) });
      // Re-select the same page so the baseline reloads, which is what "discard" means here.
      const current = selected;
      setSelected(null);
      setTimeout(() => setSelected(current), 0);
      toast.success("已還原至基準 / reverted to baseline");
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) toast.error(describeError(error));
    }
  }

  async function publish() {
    setPublishing(true);
    try {
      const result = (await api.publish()) as { published: number; version: number };
      await client.invalidateQueries({ queryKey: queryKeys.drafts(token) });
      setHasDraft(false);
      toast.success(`已發佈 / published ${result.published} → content v${result.version}`);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setPublishing(false);
    }
  }

  const openName = isNew ? `${cleanName(draftName ?? "") || "（未命名）"}.md` : selected === null ? "" : `${selected}.md`;
  const lines = text === "" ? 0 : text.split("\n").length;
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <Card className="h-fit">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">典故 Lore</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button size="sm" variant="outline" className="w-full" onClick={newPage}>
            新頁面 New page
          </Button>
          {loreIds.isPending ? (
            <p className="text-xs text-muted-foreground">加载中…</p>
          ) : (loreIds.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">（冇典故頁 / no lore pages）</p>
          ) : (
            <ScrollArea className="max-h-[28rem]">
              <div className="space-y-1 pr-2">
                {(loreIds.data ?? []).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setDraftName(null);
                      setSelected(id);
                    }}
                    className={cn(
                      "block w-full truncate rounded px-2 py-1 text-left font-mono text-xs",
                      selected === id ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                    )}
                  >
                    {id}.md
                  </button>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={isNew ? "outline" : hasDraft ? "default" : "outline"} className="text-[10px]">
            {isNew ? "新 New" : hasDraft ? "草稿 Draft" : "基準 Baseline"}
          </Badge>
          {dirty ? (
            <Badge variant="secondary" className="text-[10px]">
              未保存 Unsaved
            </Badge>
          ) : null}
          <span className="font-mono text-[11px] text-muted-foreground">{openName}</span>
          <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
            保存草稿 Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={selected === null || isNew || !hasDraft}
            onClick={() => void discard()}
          >
            掉棄 Draft Discard
          </Button>
          <Button size="sm" variant="outline" disabled={publishing} onClick={() => void publish()}>
            發佈 Publish
          </Button>
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          呢啲頁面係作者參考：NPC 嘅提示詞讀嘅係 NPC 自己嘅 lore 欄位，物品嘅{" "}
          <code className="font-mono">lore_ref</code> 指向呢個檔名。今日兩個客戶端都唔會載入呢個檔案
          —— 發佈之後 pack 入面多咗一頁 markdown 原文。
          <br />
          These pages are authoring reference: an NPC's prompt reads the NPC's own{" "}
          <code className="font-mono">lore</code> field, and an item's{" "}
          <code className="font-mono">lore_ref</code> names this file. Neither client loads the file
          today — publishing adds the markdown to the pack.
        </p>

        {selected === null && !isNew ? (
          <p className="text-xs text-muted-foreground">
            {busy ? "加载中…" : "揀一頁，或者開新一頁 / pick a page, or start a new one"}
          </p>
        ) : (
          <>
            {isNew ? (
              <label className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground">檔名 / file name</span>
                <Input
                  className="h-7 w-56 font-mono text-[11px]"
                  value={draftName ?? ""}
                  onChange={(event) => setDraftName(event.target.value)}
                />
                <span className="font-mono text-[10px] text-muted-foreground">.md</span>
              </label>
            ) : null}

            <Textarea
              spellCheck={false}
              className="min-h-[26rem] font-mono text-xs leading-relaxed"
              placeholder="# 1955 的九龍城寨&#10;&#10;來源：…"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />

            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span>{lines} 行 / lines</span>
              <span>{words} 字 / words</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
