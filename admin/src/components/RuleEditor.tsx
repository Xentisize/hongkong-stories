/* Condition editor (§5.5) — rule rows over the JSON, driven by `lib/rules`.
 *
 * Controlled: the value comes in, a replacement goes out. The tree edits are immutable path
 * rewrites (`replaceAt` / `removeAt`), so a row is addressed by its position and every edit shares
 * the branches it did not touch.
 *
 * Two escapes are deliberate. A condition whose verb this editor does not know renders as raw JSON
 * rather than being silently reshaped into `{flag: ""}`; and the root "無條件" mode shows inert text
 * instead of an empty row, because "no condition" is a real answer and a blank rule is not.
 */

import { Button } from "@/components/ui/button";
import { JsonField } from "@/components/JsonField";
import { SpecFields } from "@/components/SpecFields";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LEAF_VERBS,
  MAX_DEPTH,
  MODES,
  freshLeaf,
  groupKey,
  isRule,
  leafFields,
  leafVerb,
  rootMode,
  withMode,
  type RootMode,
  type Rule,
} from "@/lib/rules";

export function RuleEditor({
  value,
  onChange,
  title = "條件 Condition",
}: {
  value: unknown;
  onChange: (next: Rule) => void;
  title?: string;
}) {
  const cond = isRule(value) ? value : {};
  const mode = rootMode(cond);
  const unknownShape = mode === "empty" && Object.keys(cond).length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">{title}</span>
        <Select
          value={mode}
          onValueChange={(next) => onChange(withMode(cond, (next ?? "empty") as RootMode))}
        >
          <SelectTrigger className="h-7 w-40 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map(([id, label]) => (
              <SelectItem key={id} value={id} className="text-xs">
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {unknownShape ? (
        <JsonField
          label="呢個條件用咗本編輯器未識嘅寫法，暫時用 JSON 編輯 / unknown shape, edited as JSON"
          value={cond}
          rows={4}
          onChange={(next) => onChange(isRule(next) ? next : {})}
        />
      ) : mode === "empty" ? (
        <p className="text-[10px] text-muted-foreground">無條件 — 恆真 / no condition, always true</p>
      ) : (
        <RuleNode cond={cond} depth={0} onReplace={onChange} onRemove={null} />
      )}
    </div>
  );
}

function RuleNode({
  cond,
  depth,
  onReplace,
  onRemove,
}: {
  cond: Rule;
  depth: number;
  onReplace: (next: Rule) => void;
  onRemove: (() => void) | null;
}) {
  const group = groupKey(cond);

  if (group !== null) {
    const children = group === "not" ? null : Array.isArray(cond[group]) ? (cond[group] as unknown[]) : [];

    return (
      <div className="space-y-2 rounded-md border-l-2 border-primary/40 pl-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium">
            {group === "not" ? "not（取反）" : group === "all" ? "all（全部滿足）" : "any（任一滿足）"}
          </span>
          {onRemove ? (
            <Button size="sm" variant="ghost" className="h-6 px-1 text-destructive" onClick={onRemove}>
              ×
            </Button>
          ) : null}
        </div>

        {children === null ? (
          <RuleNode
            cond={isRule(cond["not"]) ? (cond["not"] as Rule) : {}}
            depth={depth + 1}
            onReplace={(next) => onReplace({ ...cond, not: next })}
            onRemove={null}
          />
        ) : (
          <div className="space-y-2">
            {children.map((entry, index) => (
              <RuleNode
                key={index}
                cond={isRule(entry) ? entry : {}}
                depth={depth + 1}
                onReplace={(next) =>
                  onReplace({ ...cond, [group]: children.map((other, i) => (i === index ? next : other)) })
                }
                onRemove={() =>
                  onReplace({ ...cond, [group]: children.filter((_, i) => i !== index) })
                }
              />
            ))}
            {depth + 1 < MAX_DEPTH ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onReplace({ ...cond, [group]: [...children, freshLeaf("flag")] })}
              >
                ＋ 加一條
              </Button>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  const verb = leafVerb(cond) ?? LEAF_VERBS[0]![0];
  const specs = leafFields(verb);

  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block space-y-1">
          <span className="text-[10px] text-muted-foreground">條件</span>
          <Select value={verb} onValueChange={(next) => onReplace(freshLeaf(next ?? verb))}>
            <SelectTrigger className="h-7 w-36 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEAF_VERBS.map(([id, label]) => (
                <SelectItem key={id} value={id} className="text-xs">
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        {specs.length === 0 ? (
          <JsonField
            label="未知條件，用 JSON 編輯 / unknown verb, edited as JSON"
            value={cond}
            rows={3}
            onChange={(next) => onReplace(isRule(next) ? next : cond)}
          />
        ) : (
          <SpecFields
            specs={specs}
            value={cond}
            onPatch={(key, next) => onReplace({ ...cond, [key]: next })}
          />
        )}

        {onRemove ? (
          <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-destructive" onClick={onRemove}>
            ×
          </Button>
        ) : null}
      </div>
    </div>
  );
}
