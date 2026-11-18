/* Persona playground (PLAN 9.2): chat with a draft NPC through the real pipeline.
 *
 * Per turn the response carries REAL usage (prompt/completion/cached tokens via
 * `usage.include` — the cache-hit telemetry §7.5 wanted), cost, latency, and the actions the
 * model TRIED that the allowlist rejected — surfaced in red, never hidden. History feeds the
 * next turn, capped like the client's 12-turn window. One click queues a line for the fact-check
 * review (§7.6).
 *
 * The DOM version appended nodes to a transcript element; the transcript is now data, which is
 * what makes a per-turn fact-check verdict attach to its own turn instead of being appended in
 * whatever order the promise resolved.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { api, type PlaygroundTurn } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { describeError } from "@/lib/errors";
import type { Entity } from "@/lib/npc";
import { useDrafts, useEntityIds } from "@/lib/queries";
import { cn } from "@/lib/utils";

const LANGS = ["zh_HK", "zh_CN", "en"];

type Check = { verdict: string; reason: string };

type Entry =
  | { kind: "notice"; text: string; tone: "info" | "err" }
  | {
      kind: "turn";
      input: string;
      reply: PlaygroundTurn;
      checks: Check[];
      checking: boolean;
      error: string | null;
    };

const EMPTY_STATE = JSON.stringify(
  { flags: {}, vars: {}, inventory: {}, visited: {}, talk_counts: {}, quests: {} },
  null,
  2,
);

export function PlaygroundView({ token }: { token: string }) {
  const drafts = useDrafts(token);
  const baseline = useEntityIds(token, "npcs");

  const [selection, setSelection] = useState<string>("");
  const [lang, setLang] = useState("zh_HK");
  const [stateText, setStateText] = useState(EMPTY_STATE);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const [npc, setNpc] = useState<Entity | null>(null);
  const [history, setHistory] = useState<Array<{ role: string; content: string }>>([]);
  const [entries, setEntries] = useState<Entry[]>([]);

  const transcriptRef = useRef<HTMLDivElement>(null);

  const choices = [
    ...(drafts.data ?? [])
      .filter((draft) => draft.kind === "npcs")
      .map((draft) => ({ value: `draft:${draft.id}`, label: `草稿 · ${draft.id}` })),
    ...(baseline.data ?? []).map((id) => ({ value: `baseline:${id}`, label: id })),
  ];

  // Pick the first available NPC once the lists arrive, so the view is usable immediately.
  useEffect(() => {
    if (selection === "" && choices.length > 0) setSelection(choices[0]!.value);
  }, [choices, selection]);

  // Selecting a different NPC loads it and clears the conversation.
  useEffect(() => {
    if (!selection) return;
    let cancelled = false;
    const [kind, id] = selection.split(":");
    void (async () => {
      try {
        const loaded =
          kind === "draft"
            ? ((await api.getDraft("npcs", id)) as Entity)
            : ((await api.entity("npcs", id)) as Entity);
        if (cancelled) return;
        setNpc(loaded);
        setHistory([]);
        setEntries([{ kind: "notice", tone: "info", text: `已載入 ${id}` }]);
      } catch (error) {
        if (!cancelled) {
          setEntries([{ kind: "notice", tone: "err", text: describeError(error) }]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selection]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [entries]);

  async function sendTurn() {
    const text = input.trim();
    if (!npc || !text || sending) return;

    let state: unknown;
    try {
      state = JSON.parse(stateText);
    } catch {
      setEntries((prev) => [...prev, { kind: "notice", tone: "err", text: "狀態模擬不是合法 JSON" }]);
      return;
    }

    setSending(true);
    try {
      const turn = (await api.playground({
        npc,
        state,
        lang,
        history,
        input: text,
      })) as PlaygroundTurn;

      const nextHistory = [
        ...history,
        { role: "user", content: text },
        { role: "assistant", content: turn.say },
      ];
      while (nextHistory.length > 12) nextHistory.shift();
      setHistory(nextHistory);
      setEntries((prev) => [
        ...prev,
        { kind: "turn", input: text, reply: turn, checks: [], checking: false, error: null },
      ]);
      setInput("");
    } catch (error) {
      setEntries((prev) => [
        ...prev,
        { kind: "notice", tone: "err", text: `turn 失敗: ${describeError(error)}` },
      ]);
    } finally {
      setSending(false);
    }
  }

  async function runCheck(index: number) {
    const entry = entries[index];
    if (!entry || entry.kind !== "turn" || !npc) return;

    const patch = (next: Partial<Extract<Entry, { kind: "turn" }>>) =>
      setEntries((prev) =>
        prev.map((item, at) =>
          at === index && item.kind === "turn" ? { ...item, ...next } : item,
        ),
      );

    patch({ checking: true, error: null });
    try {
      const result = (await api.factcheckCheck({
        npc,
        player_input: entry.input,
        reply: entry.reply.say,
      })) as Check & { id: string };
      patch({
        checking: false,
        checks: [...entry.checks, { verdict: result.verdict, reason: result.reason }],
      });
      toast.success("已入審閱隊列 / queued for review");
    } catch (error) {
      patch({ checking: false, error: `fact-check 失敗: ${describeError(error)}` });
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Playground</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">NPC</Label>
              <Select value={selection} onValueChange={(next) => setSelection(next ?? "")}>
                <SelectTrigger className="h-8 w-72">
                  <SelectValue placeholder="載入 NPC" />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">語言</Label>
              <Select value={lang} onValueChange={(next) => setLang(next ?? "zh_HK")}>
                <SelectTrigger className="h-8 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {npc ? (
              <Badge variant="outline" className="mb-1 text-[10px]">
                {String(npc["id"])}
              </Badge>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              狀態模擬（state projection，如同遊戲內會话）
            </Label>
            <Textarea
              rows={5}
              spellCheck={false}
              className="font-mono text-xs"
              value={stateText}
              onChange={(event) => setStateText(event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-3">
          <div ref={transcriptRef} className="h-96 overflow-auto rounded border">
            <div className="space-y-3 p-3">
              {entries.map((entry, index) =>
                entry.kind === "notice" ? (
                  <p
                    key={index}
                    className={cn(
                      "text-xs",
                      entry.tone === "err" ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {entry.text}
                  </p>
                ) : (
                  <Turn
                    key={index}
                    entry={entry}
                    onCheck={() => void runCheck(index)}
                    npcId={String(npc?.["id"] ?? "?")}
                  />
                ),
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Input
              placeholder="以玩家身份說话…（Enter 發送）"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void sendTurn();
              }}
              disabled={!npc || sending}
            />
            <Button onClick={() => void sendTurn()} disabled={!npc || sending}>
              {sending ? "…" : "發送"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Turn({
  entry,
  npcId,
  onCheck,
}: {
  entry: Extract<Entry, { kind: "turn" }>;
  npcId: string;
  onCheck: () => void;
}) {
  const { reply } = entry;
  const cached = Math.round((reply.usage.cache_ratio ?? 0) * 100);

  const rejected = new Map<string, number>();
  for (const item of reply.rejected) {
    rejected.set(item.reason, (rejected.get(item.reason) ?? 0) + 1);
  }

  const stats = [
    `⌛ ${reply.latency_ms}ms`,
    `in ${reply.usage.prompt_tokens} tok（cached ${cached}%）`,
    `out ${reply.usage.completion_tokens}`,
    `$${reply.usage.cost_usd}`,
    `mood: ${reply.mood}`,
    reply.truncated ? "· 截斷!" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-1 rounded border-l-2 border-muted pl-3 text-xs">
      <p className="text-[11px] text-muted-foreground">玩家</p>
      <p>{entry.input}</p>
      <p className="pt-1 text-[11px] text-muted-foreground">
        {npcId} · {reply.model}
      </p>
      <p className="text-sm">{reply.say}</p>
      <p className="text-[11px] text-muted-foreground">{stats}</p>
      {reply.actions.length > 0 ? (
        <p className="text-emerald-500">動作: {JSON.stringify(reply.actions)}</p>
      ) : null}
      {rejected.size > 0 ? (
        <p className="text-destructive">
          被拒動作:{" "}
          {[...rejected.entries()].map(([reason, count]) => `${reason}×${count}`).join(", ")}
        </p>
      ) : null}
      {entry.checks.map((check, index) => (
        <p key={index} className="text-amber-500">
          fact-check: {check.verdict} — {check.reason}（已入審閱隊列）
        </p>
      ))}
      {entry.error ? <p className="text-destructive">{entry.error}</p> : null}
      <Button size="sm" variant="ghost" className="h-6 px-2" onClick={onCheck} disabled={entry.checking}>
        {entry.checking ? "…" : "fact-check"}
      </Button>
    </div>
  );
}
