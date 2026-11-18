/* Field rows for a rule object, described by `lib/rules` FieldSpecs.
 *
 * One renderer for both vocabularies: a condition leaf's parameters and an effect's parameters are
 * the same four shapes (text, number, select, localized), so the two editors share this instead of
 * growing their own copies that drift apart.
 */

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { asLocalized, writeLocale } from "@/lib/localized";
import type { FieldSpec, Rule } from "@/lib/rules";

const LOCALES = ["zh_HK", "zh_CN", "en"] as const;
const LOCALE_LABELS: Record<string, string> = { zh_HK: "繁 HK", zh_CN: "簡 CN", en: "EN" };

/** Numbers arrive from an `<input type="number">` as strings; an emptied box is not `0`. */
function asNumber(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

export function SpecFields({
  specs,
  value,
  onPatch,
}: {
  specs: FieldSpec[];
  value: Rule;
  onPatch: (key: string, next: unknown) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      {specs.map((spec) => {
        if (spec.kind === "select") {
          const options = spec.options ?? [];
          return (
            <label key={spec.key} className="block space-y-1">
              <span className="text-[10px] text-muted-foreground">{spec.label}</span>
              <Select
                value={String(value[spec.key] ?? options[0] ?? "")}
                onValueChange={(next) => onPatch(spec.key, next ?? options[0] ?? "")}
              >
                <SelectTrigger className="h-7 w-24 text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((option) => (
                    <SelectItem key={option} value={option} className="text-xs">
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          );
        }

        if (spec.kind === "localized") {
          const table = asLocalized(value[spec.key]);
          return (
            <div key={spec.key} className="w-full space-y-1">
              <span className="text-[10px] text-muted-foreground">{spec.label}</span>
              <div className="grid grid-cols-3 gap-1">
                {LOCALES.map((locale) => (
                  <Input
                    key={locale}
                    className="h-7 text-[11px]"
                    placeholder={LOCALE_LABELS[locale]}
                    value={table[locale] ?? ""}
                    onChange={(event) =>
                      onPatch(spec.key, writeLocale(value[spec.key], locale, event.target.value))
                    }
                  />
                ))}
              </div>
            </div>
          );
        }

        if (spec.kind === "boolean") {
          // Absent means "the interpreter's default", which for every boolean here is true; the box
          // therefore reads its checked state from `!== false` rather than `=== true`.
          return (
            <label key={spec.key} className="flex items-center gap-1.5 pb-1 text-[10px] text-muted-foreground">
              <Checkbox
                checked={value[spec.key] !== false}
                onCheckedChange={(checked) => onPatch(spec.key, checked === true)}
              />
              {spec.label}
            </label>
          );
        }

        const numeric = spec.kind === "number";
        return (
          <label key={spec.key} className="block space-y-1">
            <span className="text-[10px] text-muted-foreground">{spec.label}</span>
            <Input
              type={numeric ? "number" : "text"}
              className={numeric ? "h-7 w-20 font-mono text-[11px]" : "h-7 w-40 font-mono text-[11px]"}
              placeholder={spec.placeholder}
              value={numeric ? String(value[spec.key] ?? "") : String(value[spec.key] ?? "")}
              onChange={(event) =>
                onPatch(spec.key, numeric ? asNumber(event.target.value) : event.target.value)
              }
            />
          </label>
        );
      })}
    </div>
  );
}
