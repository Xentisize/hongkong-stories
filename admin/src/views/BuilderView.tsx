/* Condition builder (PLAN 9.2) — rule rows that emit §5.5 JSON, with a live evaluator.
 *
 * React port of `src/builder.ts`. The §5.5 JSON object IS the model: rows read and write paths
 * into it, structural changes re-render, parameter edits mutate in place.
 *
 * Evaluation runs locally through `@hkstories/core` — the same evaluator the game client uses
 * and the one the server will use once ported. The DOM version reached this by way of a
 * `POST /v1/admin/evaluate_condition` round trip on a 400 ms debounce; the answer is now instant
 * and still appears with the backend stopped.
 *
 * The model is mutated in place and re-rendered via `bump`, matching the original's semantics
 * for an arbitrary nested tree. Holding it in `useState` and replacing immutably would mean
 * threading copy-on-write through every recursive level for no behavioural gain.
 *
 * Because the view stays mounted while hidden, the half-authored tree survives tab switches
 * without the shell having to reach in and snapshot it.
 */

import { useReducer, useState } from "react";

import { evaluate, type Condition, type ConditionState } from "@hkstories/core";

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
import { cn } from "@/lib/utils";

type Cond = Record<string, unknown>;

const MAX_DEPTH = 4;

const LEAF_VERBS: Array<[string, string]> = [
  ["flag", "旗标 flag"],
  ["has_item", "持有 has_item"],
  ["var", "变量 var"],
  ["visited", "去过 visited"],
  ["talked", "谈过 talked"],
  ["quest_state", "任务进行到 quest_state"],
  ["quest_done", "任务完成 quest_done"],
  ["time_of_day", "时段 time_of_day"],
];

const MODES: Array<[string, string]> = [
  ["empty", "无条件（恒真）"],
  ["single", "单条"],
  ["all", "all 组（全部满足）"],
  ["any", "any 组（任一满足）"],
  ["not", "not 包裹（取反）"],
];

const COMPARISONS = ["==", "!=", ">", ">=", "<", "<="];

function isCondObject(value: unknown): value is Cond {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGroup(cond: unknown): boolean {
  if (!isCondObject(cond)) return false;
  const keys = Object.keys(cond);
  return keys.includes("all") || keys.includes("any") || keys.includes("not");
}

function groupKey(cond: unknown): "all" | "any" | "not" | null {
  if (!isGroup(cond)) return null;
  const keys = Object.keys(cond as Cond);
  if (keys.includes("all")) return "all";
  if (keys.includes("any")) return "any";
  return "not";
}

function leafVerb(cond: unknown): string | null {
  if (!isCondObject(cond) || isGroup(cond)) return null;
  const keys = Object.keys(cond);
  for (const [verb] of LEAF_VERBS) {
    if (keys.includes(verb)) return verb;
  }
  return null;
}

function freshLeaf(verb: string): Cond {
  switch (verb) {
    case "has_item":
      return { has_item: "", count: 1 };
    case "var":
      return { var: "", op: ">=", value: 0 };
    case "talked":
      return { talked: "", min: 1 };
    case "quest_state":
      return { quest_state: "", node: "" };
    case "time_of_day":
      return { time_of_day: "day" };
    default:
      return { [verb]: "" };
  }
}

export function BuilderView() {
  const [model, setModel] = useState<Cond>({ flag: "" });
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [stateText, setStateText] = useState(() =>
    JSON.stringify(
      {
        flags: {},
        vars: {},
        inventory: {},
        visited: {},
        talk_counts: {},
        quests: {},
        time_of_day: "day",
      },
      null,
      2,
    ),
  );

  // The model is mutated in place; this only forces React to re-render the tree.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const commit = () => bump();

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
      : evaluate(model as Condition, state, { onWarning: (message) => warnings.push(message) });

  const mode = groupKey(model) ?? (leafVerb(model) ? "single" : "empty");

  function switchMode(next: string) {
    const leafNow = leafVerb(model) ? model : { flag: "" };
    if (next === "empty") setModel({});
    else if (next === "single") setModel(leafNow);
    else if (next === "not") setModel({ not: leafNow });
    else setModel({ [next]: [leafNow] });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center gap-3 space-y-0 pb-3">
          <CardTitle className="text-sm">条件构造 Condition</CardTitle>
          <div className="ml-auto flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">根类型</Label>
            <Select value={mode} onValueChange={(next) => switchMode(next ?? "empty")}>
              <SelectTrigger className="h-8 w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <EvalBadge pass={pass} warnings={warnings} stateError={stateError} />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <CondRoot model={model} setModel={setModel} onCommit={commit} />
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
                  const parsed = JSON.parse(importText);
                  setModel(isCondObject(parsed) ? parsed : { flag: "" });
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

/** Top level: a group renders its members, anything else renders as a single node. */
function CondRoot({
  model,
  setModel,
  onCommit,
}: {
  model: Cond;
  setModel: (next: Cond) => void;
  onCommit: () => void;
}) {
  const key = groupKey(model);

  if (key === "all" || key === "any") {
    const arr = Array.isArray(model[key]) ? (model[key] as unknown[]) : [];
    return (
      <div className="space-y-2">
        {arr.map((_, index) => (
          <CondNode
            key={index}
            cond={isCondObject(arr[index]) ? (arr[index] as Cond) : {}}
            depth={1}
            onCommit={onCommit}
            onRemove={() => {
              arr.splice(index, 1);
              onCommit();
            }}
          />
        ))}
        {1 < MAX_DEPTH ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              arr.push({ flag: "" });
              onCommit();
            }}
          >
            ＋ 加一条
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <CondNode cond={model} depth={0} onCommit={onCommit} onRemove={null} onReplace={(next) => setModel(next)} />
  );
}

/**
 * One node of the rule tree: either a group (`all` / `any` / `not`) or a leaf verb with its
 * parameters. Nesting deeper than `MAX_DEPTH` is not offered, matching the original cap.
 */
function CondNode({
  cond,
  depth,
  onCommit,
  onRemove,
  onReplace,
}: {
  cond: Cond;
  depth: number;
  onCommit: () => void;
  onRemove: (() => void) | null;
  onReplace?: (next: Cond) => void;
}) {
  if (isGroup(cond)) {
    const key = groupKey(cond) as "all" | "any" | "not";
    return (
      <div className="rounded-md border-l-2 border-primary/40 pl-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-medium">
            {key === "not" ? "not 包裹（取反）" : key === "all" ? "all 组（全部满足）" : "any 组（任一满足）"}
          </span>
          {onRemove ? (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-destructive" onClick={onRemove}>
              ×
            </Button>
          ) : null}
        </div>

        {key === "not" ? (
          <CondNode
            cond={isCondObject(cond["not"]) ? (cond["not"] as Cond) : {}}
            depth={depth + 1}
            onCommit={onCommit}
            onRemove={null}
            onReplace={(next) => {
              cond["not"] = next;
              onCommit();
            }}
          />
        ) : (
          <div className="space-y-2">
            {(Array.isArray(cond[key]) ? (cond[key] as unknown[]) : []).map((_, index) => {
              const arr = cond[key] as unknown[];
              return (
                <CondNode
                  key={index}
                  cond={isCondObject(arr[index]) ? (arr[index] as Cond) : {}}
                  depth={depth + 1}
                  onCommit={onCommit}
                  onRemove={() => {
                    arr.splice(index, 1);
                    onCommit();
                  }}
                  onReplace={(next) => {
                    arr[index] = next;
                    onCommit();
                  }}
                />
              );
            })}
            {depth + 1 < MAX_DEPTH ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const arr = Array.isArray(cond[key]) ? (cond[key] as unknown[]) : [];
                  arr.push({ flag: "" });
                  cond[key] = arr;
                  onCommit();
                }}
              >
                ＋ 加一条
              </Button>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  const verb = leafVerb(cond) ?? LEAF_VERBS[0]![0];

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border p-2">
      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">条件</Label>
        <Select
          value={verb}
          onValueChange={(next) => {
            const replacement = freshLeaf(next ?? verb);
            if (onReplace) onReplace(replacement);
            else {
              for (const key of Object.keys(cond)) delete cond[key];
              Object.assign(cond, replacement);
              onCommit();
            }
          }}
        >
          <SelectTrigger className="h-8 w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEAF_VERBS.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <LeafParams cond={cond} onCommit={onCommit} />

      {onRemove ? (
        <Button size="sm" variant="ghost" className="h-8 text-destructive" onClick={onRemove}>
          ×
        </Button>
      ) : null}
    </div>
  );
}

/** Parameters for whichever leaf verb the node currently holds. */
function LeafParams({ cond, onCommit }: { cond: Cond; onCommit: () => void }) {
  const verb = leafVerb(cond);

  const text = (label: string, key: string, fallback = "") => (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        className="h-8 w-36"
        value={String(cond[key] ?? fallback)}
        onChange={(event) => {
          cond[key] = event.target.value;
          onCommit();
        }}
      />
    </div>
  );

  const number = (label: string, key: string, fallback: number) => (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        step="any"
        className="h-8 w-24"
        value={String(cond[key] ?? fallback)}
        onChange={(event) => {
          cond[key] = Number(event.target.value);
          onCommit();
        }}
      />
    </div>
  );

  const choice = (label: string, key: string, options: string[], fallback: string) => (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Select
        value={String(cond[key] ?? fallback)}
        onValueChange={(next) => {
          cond[key] = next ?? fallback;
          onCommit();
        }}
      >
        <SelectTrigger className="h-8 w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  switch (verb) {
    case "flag":
      return (
        <>
          {text("名", "flag")}
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">应为</Label>
            <Select
              value={cond["value"] === false ? "false" : "true"}
              onValueChange={(next) => {
                cond["value"] = next !== "false";
                onCommit();
              }}
            >
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">true</SelectItem>
                <SelectItem value="false">false</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      );
    case "has_item":
      return (
        <>
          {text("物品", "has_item")}
          {number("数量", "count", 1)}
        </>
      );
    case "var":
      return (
        <>
          {text("名", "var")}
          {choice("比较", "op", COMPARISONS, ">=")}
          {number("值", "value", 0)}
        </>
      );
    case "visited":
      return text("地点", "visited");
    case "talked":
      return (
        <>
          {text("NPC", "talked")}
          {number("最少次数", "min", 1)}
        </>
      );
    case "quest_state":
      return (
        <>
          {text("任务", "quest_state")}
          {text("节点（留空=进行中）", "node")}
        </>
      );
    case "quest_done":
      return text("任务", "quest_done");
    case "time_of_day":
      return choice("时段", "time_of_day", ["day", "night"], "day");
    default:
      return null;
  }
}
