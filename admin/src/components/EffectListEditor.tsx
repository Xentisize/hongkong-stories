/* Effect list editor (§5.6) — rows over `on_interact`, `on_complete`, `on_use` and friends.
 *
 * Each row is one effect object. Rows are reordered, not just added and deleted, because order is
 * meaning here: a `say` before a `goto` reads differently from the same two reversed.
 *
 * A type the interpreter does not know yet is not an error the editor can fix, so it stays in the
 * list — shown, editable as JSON, and never silently dropped. Changing a row's type starts it from
 * that type's defaults, since keeping `flag` on a `goto` would ship a field nothing reads.
 */

import { JsonField } from "@/components/JsonField";
import { SpecFields } from "@/components/SpecFields";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EFFECT_TYPES,
  describeEffect,
  effectType,
  fieldSpecs,
  freshEffect,
  isRule,
  type Rule,
} from "@/lib/rules";

export function EffectListEditor({
  value,
  onChange,
  label = "效果 Effects",
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  label?: string;
}) {
  const raw = Array.isArray(value) ? value : [];
  const hasUnreadable = raw.some((entry) => !isRule(entry));

  if (hasUnreadable) {
    return (
      <JsonField
        label={`${label} — 有條目唔係物件，用 JSON 編輯 / an entry is not an object, edited as JSON`}
        value={value}
        rows={8}
        onChange={onChange}
      />
    );
  }

  const list = raw as Rule[];

  const replace = (index: number, next: Rule) =>
    onChange(list.map((entry, i) => (i === index ? next : entry)));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const copy = [...list];
    const [moved] = copy.splice(index, 1);
    copy.splice(target, 0, moved!);
    onChange(copy);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">
          {label}（{list.length}）
        </span>
        <Button size="sm" variant="outline" onClick={() => onChange([...list, freshEffect("set_flag")])}>
          ＋ 加效果
        </Button>
      </div>

      {list.length === 0 ? (
        <p className="text-[10px] text-muted-foreground">（冇效果 / no effects）</p>
      ) : null}

      {list.map((effect, index) => {
        const type = effectType(effect);
        const specs = fieldSpecs(type);
        const options = type !== "" && !EFFECT_TYPES.includes(type) ? [type, ...EFFECT_TYPES] : EFFECT_TYPES;

        return (
          <div key={index} className="space-y-2 rounded border p-2">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-[10px] text-muted-foreground" title={describeEffect(effect)}>
                {index + 1}. {describeEffect(effect)}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Select value={type} onValueChange={(next) => replace(index, freshEffect(next ?? "set_flag"))}>
                  <SelectTrigger className="h-7 w-32 text-[11px]">
                    <SelectValue placeholder="類型 type" />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((option) => (
                      <SelectItem key={option} value={option} className="text-xs">
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-1"
                  disabled={index === 0}
                  title="上移 Up"
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-1"
                  disabled={index === list.length - 1}
                  title="下移 Down"
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-1 text-destructive"
                  title="刪除 Delete"
                  onClick={() => onChange(list.filter((_, i) => i !== index))}
                >
                  ✕
                </Button>
              </div>
            </div>

            {specs.length === 0 ? (
              <JsonField
                label="未知效果類型，用 JSON 編輯 / unknown effect type, edited as JSON"
                value={effect}
                rows={3}
                onChange={(next) => replace(index, isRule(next) ? next : effect)}
              />
            ) : (
              <SpecFields
                specs={specs}
                value={effect}
                onPatch={(key, next) => replace(index, { ...effect, [key]: next })}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
