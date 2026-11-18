/* Condition builder (PLAN 9.2) — a workbench for §5.5 rules, with a live evaluator.
 *
 * The row editor itself is `@/components/RuleEditor`, the same one the map inspector uses for a
 * door's `requires`, an exit's gate and an object's appearance condition. That sharing is the
 * point: two condition editors in one admin drift the moment one of them learns a verb, and the
 * author ends up authoring two slightly different languages.
 *
 * What stays here is what only a workbench needs: the JSON that will be pasted into an entity, an
 * import box, and a state mock to answer "would this pass right now?" — evaluated in-process
 * through `@hkstories/core`, the same evaluator the game and the server use.
 */

import { useState } from "react";

import { evaluate, type Condition, type ConditionState } from "@hkstories/core";

import { RuleEditor } from "@/components/RuleEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { freshLeaf, isRule, type Rule } from "@/lib/rules";
import { cn } from "@/lib/utils";

const EMPTY_STATE: ConditionState = {
  flags: {},
  vars: {},
  inventory: {},
  visited: {},
  talk_counts: {},
  quests: {},
  time_of_day: "day",
};

export function BuilderView() {
  const [model, setModel] = useState<Rule>(() => freshLeaf("flag"));
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [stateText, setStateText] = useState(() => JSON.stringify(EMPTY_STATE, null, 2));

  let state: ConditionState | null = null;
  let stateError: string | null = null;
  try {
    state = JSON.parse(stateText) as ConditionState;
  } catch (error) {
    stateError = (error as Error).message;
  }

  const warnings: string[] = [];
  const pass =
    state === null
      ? null
      : evaluate(model as unknown as Condition, state, {
          onWarning: (message) => warnings.push(message),
        });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center gap-3 space-y-0 pb-3">
          <CardTitle className="text-sm">條件構造 Condition</CardTitle>
          <div className="ml-auto flex items-center gap-2">
            <EvalBadge pass={pass} warnings={warnings} stateError={stateError} />
          </div>
        </CardHeader>
        <CardContent>
          <RuleEditor value={model} onChange={setModel} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              §5.5 JSON（复制到实体的 complete_when / requires / reveal_if）
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-72 rounded border p-2">
              <pre className="font-mono text-xs">{JSON.stringify(model, null, 2)}</pre>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              粘贴条件 JSON 后点导入
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              rows={6}
              spellCheck={false}
              className={cn("font-mono text-xs", importError && "border-destructive")}
              value={importText}
              onChange={(event) => {
                setImportText(event.target.value);
                setImportError(null);
              }}
            />
            {importError ? (
              <p className="text-[11px] text-destructive">JSON 无效：{importError}</p>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                try {
                  const parsed: unknown = JSON.parse(importText);
                  setModel(isRule(parsed) ? parsed : freshLeaf("flag"));
                  setImportError(null);
                } catch (error) {
                  setImportError((error as Error).message);
                }
              }}
            >
              导入 JSON
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            状态模拟（would this pass, given this state?）
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            rows={8}
            spellCheck={false}
            className={cn("font-mono text-xs", stateError && "border-destructive")}
            value={stateText}
            onChange={(event) => setStateText(event.target.value)}
          />
          {stateError ? (
            <p className="mt-1 text-[11px] text-destructive">状态 JSON 无效：{stateError}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function EvalBadge({
  pass,
  warnings,
  stateError,
}: {
  pass: boolean | null;
  warnings: string[];
  stateError: string | null;
}) {
  if (stateError) {
    return (
      <Badge variant="outline" className="border-amber-500/60 text-amber-500">
        · 求值失败（状态 JSON 无效）
      </Badge>
    );
  }
  if (pass === null) return null;
  const tone =
    warnings.length > 0
      ? "border-amber-500/60 text-amber-500"
      : pass
        ? "border-emerald-600/60 text-emerald-500"
        : "border-destructive/60 text-destructive";
  return (
    <Badge variant="outline" className={tone} title={warnings.join("\n") || undefined}>
      {pass ? "✓ 通过" : "✗ 不通过"}
      {warnings.length > 0 ? "（有未知条件）" : ""}
    </Badge>
  );
}
