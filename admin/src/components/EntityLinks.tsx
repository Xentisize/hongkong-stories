/* The connections of the document you are editing, where you are editing it.
 *
 * The graph already existed as a tab; a creator should not have to leave the item to find out who
 * gives it. This renders the same derived edges (see `lib/connections`) as a compact strip beside the
 * fields that carry them, so "needed by which step, given by whom" is answered in place.
 */

import { useMemo } from "react";

import { connectionsFor } from "@/lib/connections";
import { cn } from "@/lib/utils";
import { usePreviewPack } from "@/studio/usePreviewPack";

export function EntityLinks({
  token,
  kind,
  id,
  max = 6,
}: {
  token: string;
  kind: string;
  /** The document being edited — its id, or the one being authored (empty while unsaved). */
  id: string;
  /** How many edges to show before the strip becomes a wall. */
  max?: number;
}) {
  const pack = usePreviewPack(token);
  const connections = useMemo(
    () => (id === "" ? { outbound: [], inbound: [] } : connectionsFor(pack.data?.tables ?? {}, kind, id)),
    [pack.data, kind, id],
  );

  if (id === "") return null;

  const inbound = connections.inbound.slice(0, max);
  const outbound = connections.outbound.slice(0, max);
  if (inbound.length === 0 && outbound.length === 0) {
    return (
      <p className="text-[10px] text-muted-foreground">
        未有連線 / nothing connects to this yet
      </p>
    );
  }

  const chip = (label: string, other: string) => (
    <span
      key={`${label}-${other}`}
      className={cn("rounded border px-1 py-0.5 font-mono text-[10px] text-muted-foreground")}
      title={other}
    >
      {other}
      <span className="ml-1 font-sans">{label}</span>
    </span>
  );

  return (
    <div className="space-y-1">
      {inbound.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted-foreground">邊個連向佢 / pointed at by</span>
          {inbound.map((ref) => chip(ref.label, ref.id))}
        </div>
      ) : null}
      {outbound.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted-foreground">佢連向邊 / points at</span>
          {outbound.map((ref) => chip(ref.label, ref.id))}
        </div>
      ) : null}
    </div>
  );
}
