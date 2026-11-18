/* Point a document at a parent, and see what the parent actually contributes.
 *
 * `extends` was resolvable before it was authorable: publish applied chains that only hand-edited
 * JSON could create. This is the missing half — a picker over the same kind, plus a preview keyed by
 * the resolver's own four rules, so an author can see "this field comes from the base, this one I
 * overrode, this one I deleted" without opening the parent file.
 *
 * The preview reads through `inheritancePreview` and, for the resolved shape, `resolvedDocument` —
 * both thin wrappers over `@hkstories/core`'s merge. A second merge implementation here would be
 * the one thing that makes an inheritance preview worse than no preview.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, api } from "@/api";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { inheritancePreview, parentCandidates, type InheritanceState } from "@/lib/inheritance";
import { useKindIds, type Entity } from "@/lib/queries";
import { cn } from "@/lib/utils";

const STATE_LABEL: Record<InheritanceState, string> = {
  inherited: "繼承 inherited",
  overridden: "覆寫 overridden",
  removed: "刪除 removed",
  own: "自有 own",
};

const STATE_TONE: Record<InheritanceState, string> = {
  inherited: "border-emerald-600/50 text-emerald-500",
  overridden: "border-amber-500/50 text-amber-500",
  removed: "border-destructive/50 text-destructive",
  own: "border-muted-foreground/40 text-muted-foreground",
};

export function InheritanceField({
  token,
  kind,
  doc,
  onChange,
  title = "繼承 Inheritance",
}: {
  token: string;
  kind: string;
  /** The document being edited. It is replaced wholesale, with or without `extends`. */
  doc: Entity;
  onChange: (next: Entity) => void;
  title?: string;
}) {
  const ids = useKindIds(token, kind);
  const selfId = String(doc["id"] ?? "");
  const candidates = useMemo(() => parentCandidates(ids.data ?? [], selfId), [ids.data, selfId]);
  const parentId = typeof doc["extends"] === "string" ? (doc["extends"] as string) : "";

  // The parent as the pack currently has it: draft first, because that is what publish would use.
  const parent = useQuery({
    queryKey: ["inheritance-parent", token, kind, parentId] as const,
    enabled: parentId !== "",
    queryFn: async () => {
      try {
        return (await api.getDraft(kind, parentId)) as Entity;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        return (await api.entity(kind, parentId)) as Entity;
      }
    },
  });

  const preview = parent.data && parentId !== "" ? inheritancePreview(parent.data, doc) : [];
  const counts = preview.reduce<Record<string, number>>((totals, entry) => {
    totals[entry.state] = (totals[entry.state] ?? 0) + 1;
    return totals;
  }, {});

  const choose = (next: string | null | undefined) => {
    const copy: Entity = { ...doc };
    if (next === undefined || next === null || next === "none") delete copy["extends"];
    else copy["extends"] = next;
    onChange(copy);
  };

  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-muted-foreground">{title}</span>
        <Select value={parentId === "" ? "none" : parentId} onValueChange={choose}>
          <SelectTrigger className="h-7 min-w-0 flex-1 font-mono text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none" className="text-xs">
              （無，自己講齊 / none）
            </SelectItem>
            {candidates.map((id) => (
              <SelectItem key={id} value={id} className="text-xs">
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {parentId === "" ? (
        <p className="text-[10px] text-muted-foreground">
          呢份文件唔繼承任何嘢 / this document stands on its own
        </p>
      ) : parent.isPending ? (
        <p className="text-[10px] text-muted-foreground">讀緊父文件… / loading parent…</p>
      ) : parent.isError ? (
        <p className="text-[10px] text-destructive">
          搵唔到父文件 '{parentId}'，發佈會被拒 / parent '{parentId}' not found — publish will refuse
          this
        </p>
      ) : (
        <>
          <p className="text-[10px] text-muted-foreground">
            {counts.inherited ?? 0} 繼承 · {counts.overridden ?? 0} 覆寫 · {counts.removed ?? 0} 刪除 ·{" "}
            {counts.own ?? 0} 自有
          </p>
          <div className="flex max-h-32 flex-wrap gap-1 overflow-auto">
            {preview
              .filter((entry) => entry.state !== "own")
              .map((entry) => (
                <Badge
                  key={entry.key}
                  variant="outline"
                  className={cn("font-mono text-[10px]", STATE_TONE[entry.state])}
                  title={STATE_LABEL[entry.state]}
                >
                  {entry.key}
                </Badge>
              ))}
          </div>
        </>
      )}

      {doc["extends"] !== undefined && parentId === "" ? null : null}
    </div>
  );
}
