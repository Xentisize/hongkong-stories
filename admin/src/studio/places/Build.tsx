/* Build: the world, with the game running your draft inside it. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, ApiError } from "@/api";
import { AssetThumb } from "@/components/AssetThumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { queryKeys, useKindIds } from "@/lib/queries";
import { placeInLocation, type LocationLike, type Placement } from "@/lib/studioPlace";
import { cn } from "@/lib/utils";
import { PreviewFrame, type PreviewSelection } from "@/studio/PreviewFrame";
import { Wizard } from "@/studio/Wizard";

const PROPS = Object.keys(import.meta.glob("../../../client/content/art/props/*.png"))
  .map((path) => `art/props/${path.split("/").pop() ?? ""}`)
  .sort();


export function BuildPlace({ token }: { token: string }) {
  const client = useQueryClient();
  const scenes = useKindIds(token, "locations");
  const characters = useKindIds(token, "npcs");

  const [selected, setSelected] = useState<string | null>(null);
  const [selection, setSelection] = useState<PreviewSelection>({
    tile: null,
    entityType: null,
    entityId: null,
  });
  const [armed, setArmed] = useState<Placement | null>(null);
  const [pickNonce, setPickNonce] = useState(0);
  /** Where the pointer is over the game while placement is armed. */
  const [hoverTile, setHoverTile] = useState<[number, number] | null>(null);
  /**
   * A palette drag: the chip captures the pointer, so it keeps reporting while the pointer is over
   * the game — a different document that never sees those events. The frame forwards the position
   * as its own pixels, and the game answers with the tile under it.
   */
  const [dragging, setDragging] = useState<Placement | null>(null);
  const [dragPoint, setDragPoint] = useState<{ clientX: number; clientY: number } | null>(null);
  const [dropNonce, setDropNonce] = useState(0);
  const [busy, setBusy] = useState(false);

  // Open on something: an empty canvas with nothing selected is what made the old map view feel
  // broken on arrival.
  useEffect(() => {
    if (selected !== null) return;
    const first = scenes.data?.[0];
    if (first !== undefined) setSelected(first);
  }, [scenes.data, selected]);

  /** Begin a drag; a plain click afterwards still arms pick mode (the drop lands on the chip). */
  function startDrag(event: React.PointerEvent<HTMLButtonElement>, placement: Placement) {
    if (busy) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers (tests, some browsers) cannot be captured; window listeners still cover it.
    }
    setDragging(placement);
    setArmed(placement);
    setDragPoint({ clientX: event.clientX, clientY: event.clientY });
  }

  // While dragging, follow the pointer and place on release.
  useEffect(() => {
    if (dragging === null) return;
    const move = (event: PointerEvent) =>
      setDragPoint({ clientX: event.clientX, clientY: event.clientY });
    const release = () => {
      setDragging(null);
      setDragPoint(null);
      setDropNonce((nonce) => nonce + 1);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [dragging]);

  function arm(placement: Placement) {
    setArmed(placement);
    setPickNonce((nonce) => nonce + 1);
  }

  /** The game answered "where?" — load the scene's draft, put the thing there, save the draft. */
  async function place(tile: [number, number]) {
    if (armed === null || selected === null || busy) return;
    setBusy(true);
    try {
      let doc: Record<string, unknown>;
      try {
        doc = (await api.getDraft("locations", selected)) as Record<string, unknown>;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        doc = (await api.entity("locations", selected)) as Record<string, unknown>;
      }

      const next = placeInLocation(doc as LocationLike, armed, tile);
      if (next === null) {
        toast.error("呢格放唔到 / that tile cannot take it");
        return;
      }

      await api.putDraft("locations", selected, next);
      await client.invalidateQueries({ queryKey: queryKeys.drafts(token) });
      toast.success(`放好咗 / placed ${armed.id} at ${tile[0]},${tile[1]}`);
      setArmed(null);
      setHoverTile(null);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Wizard token={token} />

      <PreviewFrame
        token={token}
        location={selected}
        onSelect={setSelection}
        onPick={(tile) => void place(tile)}
        onHover={setHoverTile}
        dragPoint={dragPoint}
        dropNonce={dropNonce}
        pickNonce={pickNonce}
      />

      {armed !== null ? (
        <p className="rounded border border-primary/50 bg-primary/5 p-2 text-[11px]">
          喺上面嘅遊戲畫面點一格，放 {armed.id}
          {hoverTile !== null ? (
            <span className="ml-1 font-mono text-primary">
              → tile {hoverTile[0]}, {hoverTile[1]}
            </span>
          ) : null}
          <br />
          Click a tile in the game above to place {armed.id}
          {hoverTile !== null ? ` at ${hoverTile[0]},${hoverTile[1]}` : ""}.
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => {
              setArmed(null);
              setHoverTile(null);
            }}
          >
            取消 cancel
          </button>
        </p>
      ) : null}

      <div className="rounded-lg border p-3">
        <p className="text-xs font-medium">揀咗 / selected</p>
        {selection.tile === null ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            喺上面嘅遊戲畫面點一下 / click something in the game above
          </p>
        ) : (
          <div className="mt-1 space-y-1 text-[11px]">
            <p className="font-mono text-muted-foreground">
              tile {selection.tile[0]}, {selection.tile[1]}
            </p>
            {selection.entityId !== null && selection.entityId !== "" ? (
              <div className="flex items-center gap-2">
                <AssetThumb path={`res://content/art/npcs/${selection.entityId}.png`} size={24} />
                <span className="font-mono">{selection.entityId}</span>
                <Badge variant="outline" className="text-[9px]">
                  {selection.entityType ?? "?"}
                </Badge>
              </div>
            ) : (
              <p className="text-muted-foreground">地面 / empty ground</p>
            )}
            <p className="text-muted-foreground">
              詳細編輯器喺下一個階段 / the detailed editor arrives in a later phase
            </p>
          </div>
        )}
      </div>

      <div className="rounded-lg border p-3">
        <p className="text-xs font-medium">放置 Palette</p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          揀一個，然後喺遊戲畫面點位 / pick one, then click a spot in the game
        </p>

        <p className="mt-2 text-[10px] text-muted-foreground">角色 Characters</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {(characters.data ?? []).map((id) => (
            <button
              key={id}
              type="button"
              title={id}
              disabled={busy}
              onPointerDown={(event) => startDrag(event, { kind: "npc", id })}
              onClick={() => arm({ kind: "npc", id })}
              className={cn(
                "flex items-center gap-1 rounded border px-1 py-0.5 text-[10px]",
                armed?.kind === "npc" && armed.id === id
                  ? "border-primary bg-primary/10"
                  : "hover:bg-muted",
              )}
            >
              <AssetThumb path={`res://content/art/npcs/${id}.png`} size={20} className="border-0" />
              <span className="font-mono">{id}</span>
            </button>
          ))}
        </div>

        <p className="mt-2 text-[10px] text-muted-foreground">道具 Props</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {PROPS.map((art) => (
            <button
              key={art}
              type="button"
              title={art}
              disabled={busy}
              onPointerDown={(event) => startDrag(event, { kind: "decor", id: art })}
              onClick={() => arm({ kind: "decor", id: art })}
              className={cn(
                "rounded border-2 p-0.5",
                armed?.kind === "decor" && armed.id === art
                  ? "border-primary"
                  : "border-transparent hover:border-muted-foreground/40",
              )}
            >
              <AssetThumb path={`res://content/${art}`} size={24} className="border-0" />
            </button>
          ))}
        </div>

        {/* A door is a grid cell, not an object: placing it paints the legend's door character.
            The scene's own legend decides whether that is allowed, and refuses politely if not. */}
        <p className="mt-2 text-[10px] text-muted-foreground">格 Tile</p>
        <div className="mt-1 flex flex-wrap gap-1">
          <button
            type="button"
            title="門 door（圖集 D）"
            disabled={busy}
            onPointerDown={(event) => startDrag(event, { kind: "tile", id: "D" })}
              onClick={() => arm({ kind: "tile", id: "D" })}
            className={cn(
              "rounded border px-2 py-0.5 text-[10px]",
              armed?.kind === "tile" && armed.id === "D"
                ? "border-primary bg-primary/10"
                : "hover:bg-muted",
            )}
          >
            門 Door
          </button>
        </div>
      </div>

      <label className="space-y-1 text-[10px] text-muted-foreground">
        <span>場景 Scenes（揀一個就會跳去嗰度 / pick a scene and the game goes there）</span>
        <select
          value={selected ?? ""}
          onChange={(event) => setSelected(event.target.value === "" ? null : event.target.value)}
          className="h-8 w-full rounded border border-input bg-background px-1 font-mono text-[11px] text-foreground"
        >
          <option value="">（揀一個）</option>
          {(scenes.data ?? []).map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
