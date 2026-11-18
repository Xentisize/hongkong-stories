/* Review view (PLAN 9.2): the fact-check queue + the usage dashboard.
 *
 * Queue rule from §7.6: entries are flagged for human review and resolved by a person; nothing
 * here ever rewrites the player's words. The dashboard aggregates the month's usage ledger
 * server-side: spend (chat / image / fact-check), turns, tokens, p95 latency, top rejected
 * action reasons, costliest sessions.
 *
 * Both panels are Query-backed, so resolving an entry invalidates the queue and the dashboard
 * together rather than leaving the spend figure stale next to a changed row.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, type FactEntry } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeError } from "@/lib/errors";
import { queryKeys, useFactcheckQueue, useUsage } from "@/lib/queries";
import { cn } from "@/lib/utils";

export function ReviewView({ token }: { token: string }) {
  const client = useQueryClient();
  const queue = useFactcheckQueue(token, true);
  const usage = useUsage(token, true);

  const resolve = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.factcheckResolve(id, status),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.factcheck(token) });
      void client.invalidateQueries({ queryKey: queryKeys.usage(token) });
    },
    onError: (error) => toast.error(describeError(error)),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">
            Fact-check 審閱隊列（§7.6：只標記，從不改寫玩家的话）
          </CardTitle>
        </CardHeader>
        <CardContent>
          {queue.isPending ? (
            <p className="text-xs text-muted-foreground">加載中…</p>
          ) : queue.isError ? (
            <p className="text-xs text-destructive">隊列加載失敗: {describeError(queue.error)}</p>
          ) : queue.data.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              （隊列為空 — 在 Playground 對某輪回復點 fact-check）
            </p>
          ) : (
            <ScrollArea className="max-h-96">
              <div className="space-y-2 pr-2">
                {queue.data.map((entry) => (
                  <QueueRow
                    key={entry.id}
                    entry={entry}
                    busy={resolve.isPending}
                    onResolve={(status) => resolve.mutate({ id: entry.id, status })}
                  />
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">用量 · 本月</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {usage.isPending ? (
            <p className="text-xs text-muted-foreground">加載中…</p>
          ) : usage.isError ? (
            <p className="text-xs text-destructive">用量加載失敗: {describeError(usage.error)}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {[
                  [`$${usage.data.chat_cost_usd}`, "對话花费（本月）"],
                  [`$${usage.data.image_cost_usd}`, "圖像花费"],
                  [`$${usage.data.factcheck_cost_usd ?? 0}`, "fact-check 花费"],
                  [`${usage.data.turns}`, "輪數"],
                  [`${usage.data.tokens}`, "tokens"],
                  [`${usage.data.p95_latency_ms}ms`, "p95 延遲"],
                ].map(([value, title]) => (
                  <div key={title} className="rounded-md border p-3">
                    <div className="text-lg font-semibold tabular-nums">{value}</div>
                    <div className="text-[11px] text-muted-foreground">{title}</div>
                  </div>
                ))}
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">被拒動作</p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>被拒原因</TableHead>
                        <TableHead className="text-right">次數</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {usage.data.top_rejected.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={2} className="text-muted-foreground">
                            （沒有被拒動作）
                          </TableCell>
                        </TableRow>
                      ) : (
                        usage.data.top_rejected.map((item) => (
                          <TableRow key={item.reason}>
                            <TableCell className="font-mono text-xs">{item.reason}</TableCell>
                            <TableCell className="text-right tabular-nums">{item.count}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>

                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">花费最高的會话</p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>會话</TableHead>
                        <TableHead className="text-right">輪數</TableHead>
                        <TableHead className="text-right">花费 $</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {usage.data.sessions.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={3} className="text-muted-foreground">
                            （本月暫無會话記錄）
                          </TableCell>
                        </TableRow>
                      ) : (
                        usage.data.sessions.map((item) => (
                          <TableRow key={item.session}>
                            <TableCell className="font-mono text-xs">
                              {item.session.slice(0, 12)}…
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{item.turns}</TableCell>
                            <TableCell className="text-right tabular-nums">{item.cost_usd}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function QueueRow({
  entry,
  busy,
  onResolve,
}: {
  entry: FactEntry;
  busy: boolean;
  onResolve: (status: string) => void;
}) {
  return (
    <div className="space-y-1 rounded border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            "text-[10px]",
            entry.verdict === "ok"
              ? "border-emerald-600/60 text-emerald-500"
              : "border-destructive/60 text-destructive",
          )}
        >
          {entry.verdict}
        </Badge>
        <span className="text-muted-foreground">
          {entry.npc_id || "?"} · {entry.status} · {entry.ts.slice(0, 16).replace("T", " ")}
        </span>
        {entry.status === "open" ? (
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onResolve("dismissed")}>
              駁回 Dismiss
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onResolve("confirmed")}>
              確認 Confirmed
            </Button>
          </span>
        ) : null}
      </div>
      <p>{excerpt(`玩家: ${entry.player_input || "（無）"} → NPC: ${entry.reply}`)}</p>
      <p className="text-muted-foreground">{entry.reason}</p>
    </div>
  );
}

function excerpt(text: string, limit = 80): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
