/* The co-pilot dock: describe it, read the plan, approve the change.
 *
 * The rule the whole feature hangs on: the model never writes. It returns a proposal — the steps it
 * intends and the complete documents it would create — and this panel shows both before anything
 * touches the pack. Approving writes ordinary drafts, so the result is validated, undoable and
 * publishable exactly like a hand-typed edit; rejecting costs nothing.
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { describeDiff, describeProposal, diffDocuments, type Proposal } from "@hkstories/core";

import { api, ApiError } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { queryKeys } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** The things a first-time creator most often wants to say, as buttons rather than prose. */
const STARTERS = [
  "一條夜晚嘅後巷，有一檔魚蛋 / a night alley with a fishball stall",
  "加一個賣茶嘅阿婆，佢會提起舊相簿 / a tea seller who mentions an old album",
  "把呢個想法變成三步任務 / turn that idea into a three-step quest",
];

export function Copilot({
  token,
  pendingIntent,
}: {
  token: string;
  /** Another place asking the co-pilot something; a new nonce fires a proposal. */
  pendingIntent?: { text: string; nonce: number };
}) {
  const client = useQueryClient();
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  /** Field-level diff per changed document, computed when the proposal arrives. */
  const [diffs, setDiffs] = useState<Record<string, string[]>>({});

  /**
   * Another place asked something — the story map's "add a step", for instance. The intent is shown
   * and proposed at once, so the author never has to retype what the button already knows.
   */
  useEffect(() => {
    if (pendingIntent === undefined || pendingIntent.nonce <= 0) return;
    setIntent(pendingIntent.text);
    void propose(pendingIntent.text);
    // Only a new nonce is a new question; the text alone would re-fire on every render.
  }, [pendingIntent?.nonce]);

  async function propose(text: string) {
    const trimmed = text.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    setProposal(null);
    setDiffs({});
    try {
      const result = (await api.aiPropose(trimmed)) as { proposal: Proposal; cost_usd?: number };
      setProposal(result.proposal);
      setCost(typeof result.cost_usd === "number" ? result.cost_usd : null);
      void loadDiffs(result.proposal);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  /**
   * What an `update` would actually change.
   *
   * A summary line says what the author asked for; this says what will be written. A diff that cannot
   * be computed (a draft that vanished, a network hiccup) is left out rather than invented — the card
   * then shows only the summary, which is still true.
   */
  async function loadDiffs(proposal: Proposal) {
    const computed: Record<string, string[]> = {};
    for (const change of proposal.changes) {
      if (change.op !== "update") continue;
      const key = `${change.kind}/${change.id}`;
      try {
        let before: unknown;
        try {
          before = await api.getDraft(change.kind, change.id);
        } catch (cause) {
          if (!(cause instanceof ApiError) || cause.status !== 404) throw cause;
          before = await api.entity(change.kind, change.id);
        }
        computed[key] = describeDiff(diffDocuments(before, change.doc));
      } catch {
        // leave it out
      }
    }
    setDiffs(computed);
  }

  async function approve() {
    if (proposal === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      for (const change of proposal.changes) {
        await api.putDraft(change.kind, change.id, change.doc);
      }
      await client.invalidateQueries({ queryKey: queryKeys.drafts(token) });
      toast.success(`${proposal.changes.length} 個草稿寫好 / ${proposal.changes.length} drafts written`);
      setProposal(null);
      setIntent("");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">AI 副駕 Copilot</span>
        <Badge variant="outline" className="text-[9px]">
          P3
        </Badge>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        用一句話講你想點，佢會先出計劃同改動，等你批准先寫入草稿。
        <br />
        Describe what you want. It shows a plan and the change, and writes nothing until you approve.
      </p>

      <div className="flex gap-1">
        <input
          value={intent}
          disabled={busy}
          placeholder="例如：加一間茶餐廳同一個阿婆…"
          onChange={(event) => setIntent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void propose(intent);
          }}
          className={cn(
            "h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 text-xs",
            "placeholder:text-muted-foreground",
          )}
        />
        <Button size="sm" disabled={busy || intent.trim() === ""} onClick={() => void propose(intent)}>
          {busy ? "…" : "→"}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1">
        {STARTERS.map((starter) => (
          <button
            key={starter}
            type="button"
            disabled={busy}
            onClick={() => {
              setIntent(starter);
              void propose(starter);
            }}
            className="rounded border px-1.5 py-0.5 text-left text-[10px] text-muted-foreground hover:bg-muted"
          >
            {starter.split(" / ")[0]}
          </button>
        ))}
      </div>

      {error !== null ? (
        <p className="rounded border border-destructive/40 p-2 text-[11px] text-destructive">{error}</p>
      ) : null}

      {proposal !== null ? (
        <div className="space-y-2 rounded-md border p-2">
          <p className="text-[11px] font-medium">計劃 Plan</p>
          <ol className="list-decimal space-y-0.5 pl-4 text-[11px] text-muted-foreground">
            {proposal.plan.map((step, index) => (
              <li key={`${index}-${step}`}>{step}</li>
            ))}
          </ol>

          <p className="text-[11px] font-medium">改動 Changes（{proposal.changes.length}）</p>
          <ul className="space-y-0.5 text-[11px] text-muted-foreground">
            {describeProposal(proposal).map((line) => (
              <li key={line} className="font-mono">
                {line}
              </li>
            ))}
          </ul>

          {Object.keys(diffs).length > 0 ? (
            <div className="space-y-1">
              <p className="text-[11px] font-medium">實際改動 What changes</p>
              {Object.entries(diffs).map(([key, lines]) => (
                <div key={key} className="space-y-0.5">
                  <p className="font-mono text-[10px] text-muted-foreground">{key}</p>
                  <ul className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
                    {lines.slice(0, 6).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                    {lines.length > 6 ? <li>… 另外 {lines.length - 6} 項 / more</li> : null}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}

          {cost !== null ? (
            <p className="text-[10px] text-muted-foreground">成本 cost ${cost.toFixed(4)}</p>
          ) : null}

          <div className="flex gap-1">
            <Button size="sm" disabled={busy} onClick={() => void approve()}>
              批准 Approve
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setProposal(null)}>
              唔要 Reject
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
