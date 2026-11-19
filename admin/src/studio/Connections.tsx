/* Connections: an entity in the middle, its relationships around it.
 *
 * The question a creator actually asks is "what is this item *for*?" — who gives it, which step
 * needs it, which door it opens. That is answerable from the pack itself (`has_item`, `add_item`,
 * `talked`, `npc`, an exit's `to`), so this panel is a projection of those references, not a new
 * document to maintain. Every edge is a link to the other end, which is what makes it navigable
 * instead of a report.
 */

import { useEffect, useMemo, useState } from "react";

import { api } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AssetThumb } from "@/components/AssetThumb";
import { connectionsFor, flagsIn, gapsFor, summarise, tableLabel, type Ref } from "@/lib/connections";
import { cn } from "@/lib/utils";
import { usePreviewPack } from "@/studio/usePreviewPack";

/** The kinds a creator picks between, in the order the game introduces them. */
const PICKABLE = [
  { table: "items", label: "物品 Items" },
  { table: "npcs", label: "角色 Characters" },
  { table: "quests", label: "任務 Quests" },
  { table: "locations", label: "場景 Scenes" },
  { table: "flags", label: "旗標 Flags（隱形膠水 / the invisible glue）" },
] as const;

/** Which pickable kind an edge's other end belongs to. */
function tableFor(ref: Ref): string | null {
  if (ref.kind === "item") return "items";
  if (ref.kind === "npc") return "npcs";
  if (ref.kind === "location") return "locations";
  if (ref.kind === "quest" || ref.kind === "chapter") return "quests";
  if (ref.kind === "flag") return "flags";
  return null;
}

function iconFor(table: string, id: string): string | null {
  if (table === "items") return `res://content/art/items/${id}.png`;
  if (table === "npcs") return `res://content/art/npcs/${id}.png`;
  return null;
}

export function Connections({
  token,
  onOpen,
  onAsk,
  onContext,
}: {
  /** The admin bearer token the preview pack is read with. */
  token: string;
  /** Jump to the other end of an edge, when that end lives somewhere the studio can open. */
  onOpen?: (table: string, id: string) => void;
  /** Hand a gap straight to the co-pilot: "fix it" should not make the author describe it. */
  onAsk?: (intent: string) => void;
  /** Tell the shell what is on screen, so the co-pilot knows what "this" means. */
  onContext?: (context: { kind: string; id: string } | null) => void;
}) {
  const pack = usePreviewPack(token);

  const [table, setTable] = useState<string>("items");
  const [id, setId] = useState<string>("");

  const tables = pack.data?.tables ?? {};
  // Flags are not documents: their list is every name the pack mentions.
  const ids = useMemo(
    () => (table === "flags" ? flagsIn(tables) : Object.keys(tables[table] ?? {}).sort()),
    [tables, table],
  );
  const chosen = ids.includes(id) ? id : (ids[0] ?? "");

  const connections = useMemo(
    () => (chosen === "" ? { outbound: [], inbound: [] } : connectionsFor(tables, table, chosen)),
    [tables, table, chosen],
  );
  const lines = summarise(connections);
  const gaps = useMemo(
    () => (chosen === "" ? [] : gapsFor(tables, table, chosen)),
    [tables, table, chosen],
  );

  // What is on screen is what the co-pilot should understand by "this".
  useEffect(() => {
    if (onContext === undefined) return;
    onContext(chosen === "" ? null : { kind: table, id: chosen });
  }, [table, chosen, onContext]);

  function renderRow(ref: Ref, direction: "in" | "out") {
    const target = tableFor(ref);
    return (
      <li key={`${direction}-${ref.kind}-${ref.id}-${ref.path}`}>
        <button
          type="button"
          disabled={target === null}
          onClick={() => {
            if (target === null) return;
            setTable(target);
            setId(ref.id);
            onOpen?.(target, ref.id);
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded border px-2 py-1 text-left text-[11px]",
            ref.declared === true && "border-dashed",
            target === null ? "opacity-70" : "hover:bg-muted",
          )}
        >
          {iconFor(target ?? "", ref.id) !== null ? (
            <AssetThumb path={iconFor(target ?? "", ref.id)} size={18} className="border-0" />
          ) : null}
          <span className="font-mono">{ref.id}</span>
          <span className="text-muted-foreground">{ref.label}</span>
          {ref.declared === true ? (
            <Badge variant="outline" className="ml-auto border-dashed text-[9px]">
              聲明 declared
            </Badge>
          ) : null}
        </button>
      </li>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border p-3">
        <p className="text-xs font-medium">接駁 Connections</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          揀一件嘢，睇下邊個畀佢、邊樣需要佢、佢又指向咩。連線全部由內容本身推導。
          <br />
          Pick anything to see who gives it, what needs it, and what it leads to — derived from the
          content itself.
        </p>

        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-[10px] text-muted-foreground">
            <span>類型 Kind</span>
            <select
              value={table}
              onChange={(event) => {
                setTable(event.target.value);
                setId("");
              }}
              className="h-8 w-full rounded border border-input bg-background px-1 text-[11px] text-foreground"
            >
              {PICKABLE.map((entry) => (
                <option key={entry.table} value={entry.table}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-[10px] text-muted-foreground">
            <span>{tableLabel(table)}</span>
            <select
              value={chosen}
              onChange={(event) => setId(event.target.value)}
              className="h-8 w-full rounded border border-input bg-background px-1 font-mono text-[11px] text-foreground"
            >
              {ids.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        </div>

        <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      {gaps.length > 0 ? (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3">
          <p className="text-xs font-medium">缺口 Gaps（{gaps.length}）</p>
          <ul className="mt-1 space-y-2">
            {gaps.map((gap) => (
              <li key={gap.kind}>
                <p className="text-[11px] leading-relaxed">{gap.hint}</p>
                {onAsk !== undefined ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 h-6 text-[10px]"
                    onClick={() => onAsk(gap.intent)}
                  >
                    叫 AI 補 / ask AI to fix
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border p-3">
          <p className="text-xs font-medium">邊個連向佢 / pointed at by（{connections.inbound.length}）</p>
          {connections.inbound.length === 0 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">冇嘢指向佢 / nothing points at it yet</p>
          ) : (
            <ul className="mt-2 space-y-1">{connections.inbound.map((ref) => renderRow(ref, "in"))}</ul>
          )}
        </div>

        <div className="rounded-lg border p-3">
          <p className="text-xs font-medium">佢連向邊 / points at（{connections.outbound.length}）</p>
          {table === "flags" ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              旗標係被動嘅：有人設定佢、有人等佢，佢自己唔會指向任何嘢。
              <br />
              A flag is passive: it is set and waited on, never pointing anywhere itself.
            </p>
          ) : connections.outbound.length === 0 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">佢未指向任何嘢 / it points at nothing yet</p>
          ) : (
            <ul className="mt-2 space-y-1">{connections.outbound.map((ref) => renderRow(ref, "out"))}</ul>
          )}
        </div>
      </div>

      {pack.isError ? (
        <Badge variant="outline" className="text-[9px]">
          讀唔到內容包 / could not load the pack
        </Badge>
      ) : null}
    </div>
  );
}
