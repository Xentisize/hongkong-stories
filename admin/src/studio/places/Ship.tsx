/* Ship: is it ready? The checklist, plus review, settings and conditions. */

import { useCallback, useEffect, useState } from "react";

import { api } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { explainIssues, shipVerdict, type Issue } from "@/lib/plainLanguage";
import { cn } from "@/lib/utils";
import { BuilderView } from "@/views/BuilderView";
import { ReviewView } from "@/views/ReviewView";
import { SettingsView } from "@/views/SettingsView";
import { Panel, TabStrip } from "@/studio/tabs";

function ShipChecklist({
  token,
  onAsk,
}: {
  token: string;
  /** Hand an intent to the co-pilot — "fix this for me" should not make the author describe it. */
  onAsk?: (intent: string) => void;
}) {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const check = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const [validation, preview] = await Promise.all([
        api.validate() as Promise<{ ok: boolean; issues: Issue[] }>,
        api.publishPreview() as Promise<{ added: unknown[]; changed: unknown[] }>,
      ]);
      setIssues(Array.isArray(validation.issues) ? validation.issues : []);
      setPending((preview.added?.length ?? 0) + (preview.changed?.length ?? 0));
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const plain = issues === null ? [] : explainIssues(issues);
  const verdict = shipVerdict(issues ?? [], pending);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-medium">出貨檢查 / ship checklist</p>
          <Badge variant={verdict.ok ? "secondary" : "outline"} className="text-[9px]">
            {verdict.ok ? "可以 / ready" : "仲未得 / blocked"}
          </Badge>
          <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={() => void check()}>
            {busy ? "檢查緊…" : "再檢查 Recheck"}
          </Button>
        </div>

        <p className="mt-2 text-[11px]">{verdict.line}</p>

        {failure !== null ? (
          <p className="mt-2 rounded border border-destructive/40 p-2 text-[11px] text-destructive">{failure}</p>
        ) : null}

        {plain.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {plain.map((issue) => (
              <li key={`${issue.path}-${issue.message}`} className="rounded border p-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge
                    variant="outline"
                    className={cn("text-[9px]", issue.level === "error" && "border-destructive/60 text-destructive")}
                  >
                    {issue.level}
                  </Badge>
                  <span className="text-[11px]">{issue.plain}</span>
                </div>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{issue.path}</p>
                {issue.hint !== undefined ? (
                  <p className="mt-0.5 text-[10px] text-muted-foreground">{issue.hint}</p>
                ) : null}
                {issue.level !== "info" && onAsk !== undefined ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 h-6 text-[10px]"
                    onClick={() =>
                      onAsk(
                        `修好呢個問題：${issue.path} — ${issue.message}。只改必要嘅嘢。/ fix this: ${issue.message} at ${issue.path}, changing only what is needed.`,
                      )
                    }
                  >
                    叫 AI 修 / ask AI to fix
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : issues !== null ? (
          <p className="mt-2 text-[11px] text-muted-foreground">冇嘢擋住 / nothing is blocking</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Ship: the checklist, plus the surfaces that belong to the end of the project — review, settings
 * and the condition builder. They were separate tabs in the old shell; here they are tabs of one
 * place, which is the whole point of four destinations instead of eleven.
 */
export function ShipPlace({
  token,
  onAsk,
  onDirtyChange,
}: {
  token: string;
  onAsk?: (intent: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [tab, setTab] = useState("check");

  return (
    <div className="space-y-3">
      <TabStrip
        tabs={[
          { id: "check", label: "檢查 Checklist" },
          { id: "review", label: "審閱 Review" },
          { id: "settings", label: "設定 Settings" },
          { id: "conditions", label: "條件 Conditions" },
        ]}
        active={tab}
        onSelect={setTab}
      />

      <Panel id="check" visible={tab === "check"}>
        <ShipChecklist token={token} onAsk={onAsk} />
      </Panel>
      <Panel id="review" visible={tab === "review"}>
        <ReviewView token={token} />
      </Panel>
      <Panel id="settings" visible={tab === "settings"}>
        <SettingsView token={token} onDirtyChange={onDirtyChange} />
      </Panel>
      <Panel id="conditions" visible={tab === "conditions"}>
        <BuilderView />
      </Panel>
    </div>
  );
}
