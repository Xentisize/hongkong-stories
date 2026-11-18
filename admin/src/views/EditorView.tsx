/* Editor view (PLAN 9.2), React port of the `editorView` half of `src/main.ts`.
 *
 * Sidebar: accepted drafts, baseline NPCs (click to clone), and "new".
 * Main: the bound entity form, the draft actions, and a feedback panel.
 *
 * Two behavioural notes:
 *
 *  - The entity is the form model and is mutated in place by `NpcForm`, exactly as the DOM
 *    version did. `forceRender` therefore exists: without it, an edit made while the draft was
 *    already dirty would mutate the object without React re-rendering, and controlled controls
 *    (checkboxes, selects) would show stale state while text inputs appeared to work.
 *  - `window.confirm` is replaced by a Dialog for publish, because the confirmation has to show
 *    the list of drafts that will be folded into the pack. A native confirm would flatten it
 *    into one unreadable line.
 */

import { useCallback, useReducer, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, type Issue } from "@/api";
import { NpcForm } from "@/components/NpcForm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { describeError } from "@/lib/errors";
import { blankNpc, type Entity } from "@/lib/npc";
import {
  useDrafts,
  useEntityIds,
  useRefreshContent,
  type PublishPreview,
  type ValidateResult,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

interface Feedback {
  level: "ok" | "err" | "warn";
  text: string;
}

export function EditorView({
  token,
  onDirtyChange,
}: {
  token: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const drafts = useDrafts(token);
  const baseline = useEntityIds(token, "npcs");
  const refresh = useRefreshContent(token);

  const [entity, setEntity] = useState<Entity | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirmPublish, setConfirmPublish] = useState<PublishPreview | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Guarantees a re-render on every edit, because the draft is mutated rather than replaced.
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  const markDirty = useCallback(() => {
    setDirty(true);
    onDirtyChange(true);
    forceRender();
  }, [onDirtyChange]);

  const markClean = useCallback(() => {
    setDirty(false);
    onDirtyChange(false);
  }, [onDirtyChange]);

  const saveDraft = useMutation({
    mutationFn: () => api.putDraft("npcs", String(entity?.["id"]), entity),
    onSuccess: () => {
      setIsNew(false);
      markClean();
      void refresh();
      toast.success(`草稿已保存 / draft saved: ${String(entity?.["id"])}`);
    },
    onError: (error) => setFeedback({ level: "err", text: describeError(error) }),
  });

  const discardDraft = useMutation({
    mutationFn: () => api.deleteDraft("npcs", String(entity?.["id"])),
    onSuccess: () => {
      setFeedback({ level: "ok", text: `草稿已删除 / draft discarded: ${String(entity?.["id"])}` });
      setEntity(null);
      setIsNew(false);
      markClean();
      void refresh();
      setConfirmDiscard(false);
    },
    onError: (error) => {
      setFeedback({ level: "err", text: describeError(error) });
      setConfirmDiscard(false);
    },
  });

  const validate = useMutation({
    mutationFn: () => api.validate() as Promise<ValidateResult>,
    onSuccess: (result) => {
      const errors = result.issues.filter((issue) => issue.level === "error").length;
      setFeedback({
        level: result.ok ? "ok" : "err",
        text: result.ok
          ? `校验通过 / valid（${result.issues.length} 条提示）\n${formatIssues(result.issues)}`
          : `校验未通过 / ${errors} 个错误\n${formatIssues(result.issues)}`,
      });
    },
    onError: (error) => setFeedback({ level: "err", text: describeError(error) }),
  });

  const publish = useMutation({
    mutationFn: () => api.publish() as Promise<{ published: number; version: number; content_hash: string }>,
    onSuccess: (result) => {
      markClean();
      setConfirmPublish(null);
      void refresh();
      setFeedback({
        level: "ok",
        text: `已发布 / published ${result.published} 个草稿 → content v${result.version} (${result.content_hash})`,
      });
    },
    onError: (error) => {
      setConfirmPublish(null);
      setFeedback({ level: "err", text: describeError(error) });
    },
  });

  async function openDraft(kind: string, id: string) {
    try {
      const draft = (await api.getDraft(kind, id)) as Entity;
      setEntity(draft);
      setIsNew(false);
      setFeedback(null);
    } catch (error) {
      setFeedback({ level: "err", text: describeError(error) });
    }
  }

  async function cloneBaseline(id: string) {
    try {
      const source = (await api.entity("npcs", id)) as Entity;
      setEntity({ ...source, id: `${id}_v2` });
      setIsNew(true);
      setFeedback({
        level: "warn",
        text: `已载入基线 ${id} — 改好 id 与内容后保存为草稿`,
      });
    } catch (error) {
      setFeedback({ level: "err", text: describeError(error) });
    }
  }

  async function startPublish() {
    try {
      const preview = (await api.publishPreview()) as PublishPreview;
      setConfirmPublish(preview);
    } catch (error) {
      setFeedback({ level: "err", text: describeError(error) });
    }
  }

  const draftKey = entity ? `${String(entity["id"])}:${isNew ? "new" : "saved"}` : "empty";

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Card className="h-fit">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">草稿 Drafts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-3 pt-0">
          <ScrollArea className="max-h-52">
            <ul className="space-y-1">
              {drafts.isPending ? <li className="text-xs text-muted-foreground">加载中…</li> : null}
              {drafts.isError ? (
                <li className="text-xs text-destructive">未连接后端 / backend unreachable</li>
              ) : null}
              {drafts.data?.length === 0 ? (
                <li className="text-xs text-muted-foreground">（无草稿）</li>
              ) : null}
              {drafts.data?.map((draft) => (
                <li key={`${draft.kind}/${draft.id}`}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs",
                      "hover:bg-accent hover:text-accent-foreground",
                    )}
                    onClick={() => void openDraft(draft.kind, draft.id)}
                  >
                    <span className="truncate">{draft.id}</span>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {draft.kind}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>

          <Separator />

          <p className="text-xs font-medium text-muted-foreground">基线 NPC（点按克隆）</p>
          <ScrollArea className="max-h-52">
            <ul className="space-y-1">
              {baseline.data?.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                    onClick={() => void cloneBaseline(id)}
                  >
                    <span className="truncate">{id}</span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      克隆
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>

          <Button
            size="sm"
            className="w-full"
            onClick={() => {
              setEntity(blankNpc());
              setIsNew(true);
              setFeedback({
                level: "warn",
                text: "新 NPC：填好 id（如 npc_ch01_hawker）、三语名称与内容后保存",
              });
            }}
          >
            ＋ 新建 NPC
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {entity ? (
          <>
            <NpcForm key={draftKey} entity={entity} isNew={isNew} onChange={markDirty} />
            <Card>
              <CardContent className="flex flex-wrap items-center gap-2 p-3">
                <Button
                  size="sm"
                  onClick={() => saveDraft.mutate()}
                  disabled={saveDraft.isPending}
                >
                  {isNew ? "保存草稿 Save" : "保存 Save"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setConfirmDiscard(true)}
                  disabled={discardDraft.isPending}
                >
                  删草稿 Discard
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => validate.mutate()}
                  disabled={validate.isPending}
                >
                  校验 Validate
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void startPublish()}
                  disabled={publish.isPending}
                >
                  发布 Publish
                </Button>
                {dirty ? <span className="text-xs text-amber-500">● 未保存</span> : null}
              </CardContent>
            </Card>
          </>
        ) : (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              从左侧选择草稿、克隆基线 NPC，或新建一个。
            </CardContent>
          </Card>
        )}

        {feedback ? (
          <Card
            className={cn(
              "border",
              feedback.level === "err" && "border-destructive/60",
              feedback.level === "warn" && "border-amber-500/60",
              feedback.level === "ok" && "border-emerald-600/50",
            )}
          >
            <CardContent className="max-h-72 overflow-auto p-3">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                {feedback.text}
              </pre>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除草稿</DialogTitle>
            <DialogDescription>
              将删除 {String(entity?.["id"] ?? "")} 的草稿。基线内容不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => discardDraft.mutate()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmPublish !== null} onOpenChange={(open) => !open && setConfirmPublish(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发布 Publish</DialogTitle>
            <DialogDescription>
              发布会把草稿并入正式内容包并递增版本，所有客户端下次启动热更新。
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-60 rounded border p-2">
            <pre className="whitespace-pre-wrap font-mono text-xs">
              {previewLines(confirmPublish)}
            </pre>
          </ScrollArea>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmPublish(null)}>
              取消
            </Button>
            <Button onClick={() => publish.mutate()} disabled={publish.isPending}>
              继续发布
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatIssues(issues: Issue[]): string {
  return issues
    .map((issue) => `[${issue.level === "error" ? "E" : "W"}] ${issue.path}: ${issue.message}`)
    .join("\n");
}

function previewLines(preview: PublishPreview | null): string {
  if (!preview) return "";
  const lines = [
    ...preview.added.map((entry) => `＋ 新增 ${entry.kind}/${entry.id}`),
    ...preview.changed.map((entry) => `~ 修改 ${entry.kind}/${entry.id}`),
  ];
  return lines.length ? lines.join("\n") : "（草稿与基线一致或无草稿）";
}
