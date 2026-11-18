import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { toast } from "sonner";

import { api, ApiError } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDrafts, useEntityIds } from "@/lib/queries";
import { normalise, reducer, type LocationDoc } from "@/lib/mapEditorState";
import {
  applyDrop,
  atlasUrl,
  blankMap,
  cellFromPoint,
  fillRect,
  growMap,
  legendEntries,
  mapSize,
  moveNpc,
  npcIndexAt,
  paintCollision,
  paintTile,
  placeNpc,
  removeNpcAt,
  selectedNpc,
  setCollisionRect,
  tileAt,
  type CollisionRect,
  type DragPayload,
  type MapNpc,
} from "@/lib/map";
import { MapCanvas, type EditorMode, type EditorTool } from "@/views/map/MapCanvas";
import { LocationPanel } from "@/views/map/LocationPanel";

/**
 * Map editor (PLAN 6.3, 9.2) — the three-panel layout.
 *
 *   ┌ hierarchy ─┬ canvas ─────────────┐
 *   ├ palette ───┼ inspector ──────────┘
 *
 * Map mode paints legend characters into `tilemap`; event mode places and moves NPC markers. Both
 * write into the **same draft** the rest of the admin uses, so a map reaches the content pack
 * through the existing validate → publish path rather than a second, private save route.
 *
 * The undo stack is a stack of documents, not of single cells: one drag paints many cells and must
 * collapse into one undo step. `paintTile` returning the same array for a no-op is what makes that
 * work — a gesture that changed nothing records nothing.
 */

// Document shape, undo reducer and the malformed-draft guard live in @/lib/mapEditorState, so they
// can be tested without rendering a canvas.

const ZOOMS = [1, 2, 3, 4];

export function MapView({ token, onDirtyChange }: { token: string; onDirtyChange?: (dirty: boolean) => void }) {
  const locations = useEntityIds(token, "locations");
  const npcIds = useEntityIds(token, "npcs");
  const drafts = useDrafts(token);

  const [state, dispatch] = useReducer(reducer, { doc: null, history: [] });
  const { doc, history } = state;
  const future = state.future ?? [];
  const canRedo = future.length > 0;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>("map");
  const [tool, setTool] = useState<EditorTool>("brush");
  const [zoom, setZoom] = useState(2);
  const [brush, setBrush] = useState<string>("#");
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [placingNpc, setPlacingNpc] = useState("");
  const [atlas, setAtlas] = useState<HTMLImageElement | null>(null);
  const [npcDoc, setNpcDoc] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<Array<{ level: string; path: string; message: string }>>([]);

  // Drag payload and pointer position are separate state: the payload is stable for the whole
  // gesture, while the point changes on every move. Keeping them apart means the window listeners
  // below subscribe once per drag instead of once per pointer event.
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);

  const dirty = history.length > 0;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const legend = useMemo(() => doc?.legend ?? {}, [doc?.legend]);
  const frames = useMemo(() => legendEntries(legend), [legend]);
  const tileSize = Number(doc?.tile_size ?? 24);
  const tilemap = doc?.tilemap ?? [];
  const size = mapSize(tilemap);
  const collisionRects: CollisionRect[] =
    doc && Array.isArray(doc.collision) ? (doc.collision as CollisionRect[]) : [];

  const draftIds = useMemo(
    () => new Set((drafts.data ?? []).filter((entry) => entry.kind === "locations").map((entry) => entry.id)),
    [drafts.data],
  );

  // First legend entry is the sensible default brush once a map is open.
  useEffect(() => {
    if (frames.length > 0 && !frames.some((frame) => frame.char === brush)) setBrush(frames[0]!.char);
  }, [frames, brush]);

  const load = useCallback(async (id: string) => {
    try {
      let raw: unknown;
      try {
        // A draft wins over the baseline: it is what publish would actually ship.
        raw = await api.getDraft("locations", id);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) raw = await api.entity("locations", id);
        else throw error;
      }
      dispatch({ type: "load", doc: normalise(raw) });
      setSelectedId(id);
      setCursor(null);
      setIssues([]);
    } catch (error) {
      toast.error(`地图加载失败 / could not load ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  // Load the atlas image whenever the map points at a different one.
  const atlasPath = typeof doc?.atlas === "string" ? doc.atlas : "";
  useEffect(() => {
    if (!atlasPath) {
      setAtlas(null);
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled) setAtlas(image);
    };
    image.onerror = () => {
      if (cancelled) return;
      setAtlas(null);
      toast.error(`图集加载失败 / atlas failed to load: ${atlasPath}`);
    };
    image.src = atlasUrl(atlasPath);
    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [atlasPath]);

  const currentNpc = doc?.npcs && cursor ? selectedNpc(doc.npcs, cursor[0], cursor[1]) : undefined;
  const currentNpcId = currentNpc?.npc;

  // Persona for the inspector — this is the "LLM System Prompt" the panel in the design calls for.
  useEffect(() => {
    if (!currentNpcId) {
      setNpcDoc(null);
      return;
    }
    let cancelled = false;
    api
      .entity("npcs", currentNpcId)
      .then((data) => {
        if (!cancelled) setNpcDoc(data as Record<string, unknown>);
      })
      .catch(() => {
        if (!cancelled) setNpcDoc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentNpcId]);

  const apply = useCallback((next: LocationDoc) => dispatch({ type: "apply", next }), []);

  const beginDrag = useCallback((payload: DragPayload, clientX: number, clientY: number) => {
    setDragPayload(payload);
    setDragPoint({ x: clientX, y: clientY });
  }, []);

  /**
   * The drag listens on `window`, not on the element that started it.
   *
   * A pointerdown captured by a palette button would never report movement over the canvas, and a
   * plain click would look identical to a drag that ended where it began — which is exactly what
   * makes "click to arm the brush, drag to paint" work as one gesture.
   */
  useEffect(() => {
    if (!dragPayload) return;

    const move = (event: PointerEvent) => setDragPoint({ x: event.clientX, y: event.clientY });

    const finish = (event: PointerEvent) => {
      const canvas = canvasHostRef.current?.querySelector("canvas");
      if (canvas && doc) {
        const rect = canvas.getBoundingClientRect();
        const cell = cellFromPoint(rect, event.clientX, event.clientY, tileSize * zoom);
        if (cell) {
          // `applyDrop` returns the same document when nothing changed, so dropping a marker back on
          // its own cell records no undo step.
          const next = applyDrop(doc, dragPayload, cell[0], cell[1]);
          if (next !== doc) {
            apply(next);
            setCursor(cell);
          }
        }
      }
      setDragPayload(null);
      setDragPoint(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [dragPayload, doc, tileSize, zoom, apply]);

  const handlePaint = useCallback(
    (x: number, y: number) => {
      if (!doc) return;
      const next = paintTile(tilemap, x, y, brush);
      if (next === tilemap) return;
      apply({ ...doc, tilemap: next });
    },
    [doc, tilemap, brush, apply],
  );

  const handleSelect = useCallback(
    (x: number, y: number) => {
      if (!doc) return;
      setCursor([x, y]);

      const npcs = doc.npcs ?? [];
      // A cell that already holds a marker always selects it, whatever else is armed.
      if (npcIndexAt(npcs, x, y) >= 0) return;

      if (placingNpc) {
        apply({ ...doc, npcs: placeNpc(npcs, placingNpc, x, y) });
        return;
      }

      // Otherwise, if a marker is selected, this click moves it.
      const index = cursor ? npcIndexAt(npcs, cursor[0], cursor[1]) : -1;
      if (index >= 0) {
        const moved = moveNpc(npcs, index, x, y);
        if (moved !== npcs) apply({ ...doc, npcs: moved });
      }
    },
    [doc, cursor, placingNpc, apply],
  );

  const handleRemoveNpc = useCallback(
    (x: number, y: number) => {
      if (!doc) return;
      apply({ ...doc, npcs: removeNpcAt(doc.npcs ?? [], x, y) });
    },
    [doc, apply],
  );

  const handleToggleCollision = useCallback(
    (x: number, y: number, solid: boolean) => {
      if (!doc) return;
      const current: CollisionRect[] = Array.isArray(doc.collision)
        ? (doc.collision as CollisionRect[])
        : [];
      const { width, height } = mapSize(doc.tilemap ?? []);
      const next = paintCollision(current, x, y, solid, width, height);
      // Same array means the cell already held that value, so dragging across solid cells records
      // no undo steps at all.
      if (next === current) return;
      apply({ ...doc, collision: next });
    },
    [doc, apply],
  );

  const handleFillRect = useCallback(
    (x0: number, y0: number, x1: number, y1: number) => {
      if (!doc) return;
      const next = fillRect(tilemap, x0, y0, x1, y1, brush);
      if (next === tilemap) return;
      apply({ ...doc, tilemap: next });
    },
    [doc, tilemap, brush, apply],
  );

  const handleFillCollision = useCallback(
    (x0: number, y0: number, x1: number, y1: number, solid: boolean) => {
      if (!doc) return;
      const current: CollisionRect[] = Array.isArray(doc.collision)
        ? (doc.collision as CollisionRect[])
        : [];
      const { width, height } = mapSize(doc.tilemap ?? []);
      const next = setCollisionRect(current, x0, y0, x1, y1, solid, width, height);
      if (next === current) return;
      apply({ ...doc, collision: next });
    },
    [doc, apply],
  );

  const handlePickTile = useCallback(
    (x: number, y: number) => {
      const picked = tileAt(tilemap, x, y);
      // A ragged row can have no character at that column; nothing to pick.
      if (picked !== undefined) setBrush(picked);
    },
    [tilemap],
  );

  const updatePlacement = useCallback(
    (patch: Partial<MapNpc>) => {
      if (!doc || !cursor) return;
      const npcs = doc.npcs ?? [];
      const index = npcIndexAt(npcs, cursor[0], cursor[1]);
      if (index < 0) return;
      apply({ ...doc, npcs: npcs.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)) });
    },
    [doc, cursor, apply],
  );

  const fillBlank = useCallback(() => {
    if (!doc) return;
    // A map with no geometry yet gets a 28x14 field of the current brush, which is the size the
    // authored streets use.
    apply({ ...doc, tilemap: growMap(tilemap.length > 0 ? tilemap : blankMap(28, 14, brush), 28, 14, brush) });
  }, [doc, tilemap, brush, apply]);

  const save = useCallback(async () => {
    if (!doc?.id) return;
    setSaving(true);
    try {
      await api.putDraft("locations", String(doc.id), doc);
      // Re-loading as the new baseline resets the undo stack: the saved state is the new origin.
      dispatch({ type: "load", doc });
      toast.success(`草稿已保存 / draft saved: ${String(doc.id)}`);
      void drafts.refetch();
    } catch (error) {
      toast.error(`保存失败 / save failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }, [doc, drafts]);

  const validate = useCallback(async () => {
    try {
      const result = (await api.validate()) as { ok: boolean; issues: Array<{ level: string; path: string; message: string }> };
      const mine = result.issues.filter((issue) => doc?.id && issue.path.includes(String(doc.id)));
      setIssues(mine);
      if (mine.length === 0) toast.success("这张地图没有问题 / no issues for this map");
      else toast.warning(`${mine.length} 个问题 / ${mine.length} issue(s) for this map`);
    } catch (error) {
      toast.error(`校验失败 / validate failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [doc?.id]);

  /**
   * Editor shortcuts — the ones a Godot or Aseprite user reaches for without thinking.
   *
   * Ignored entirely while focus is in a field: the inspector has textareas for a placement's
   * condition JSON, and stealing Ctrl+Z there would undo the map instead of the text.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable === true) {
        return;
      }

      const key = event.key.toLowerCase();

      if (event.metaKey || event.ctrlKey) {
        if (key === "z") {
          event.preventDefault();
          dispatch({ type: event.shiftKey ? "redo" : "undo" });
        } else if (key === "y") {
          event.preventDefault();
          dispatch({ type: "redo" });
        } else if (key === "s") {
          event.preventDefault();
          void save();
        }
        return;
      }

      // Bare digits switch modes, matching the tool order in the toolbar.
      if (key === "1") setMode("map");
      else if (key === "2") setMode("event");
      else if (key === "3") setMode("collision");
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  const atlasImage = atlas;
  const paletteScale = 2.5;
  // Preview frame for the drag ghost: only a tile drag has one.
  const dragFrame =
    dragPayload?.kind === "tile" ? frames.find((entry) => entry.char === dragPayload.char) : undefined;

  return (
    <div className="flex h-[calc(100vh-8.5rem)] flex-col gap-2">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border">
          {([
            ["map", "地图 Map"],
            ["event", "事件 Event"],
            ["collision", "碰撞 Collision"],
          ] as const).map(([candidate, label]) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setMode(candidate)}
              className={`px-3 py-1.5 text-xs ${mode === candidate ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex overflow-hidden rounded-md border">
          {([
            ["brush", "笔刷 Brush"],
            ["rect", "矩形 Rect"],
          ] as const).map(([candidate, label]) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setTool(candidate)}
              className={`px-3 py-1.5 text-xs ${tool === candidate ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => setZoom((value) => Math.max(1, value - 1))}>
            −
          </Button>
          <span className="w-10 text-center text-xs tabular-nums">{zoom}×</span>
          <Button size="sm" variant="outline" onClick={() => setZoom((value) => Math.min(ZOOMS[ZOOMS.length - 1]!, value + 1))}>
            +
          </Button>
        </div>

        <Button size="sm" variant="outline" disabled={history.length === 0} onClick={() => dispatch({ type: "undo" })}>
          撤销 Undo
        </Button>
        <Button size="sm" variant="outline" disabled={!canRedo} onClick={() => dispatch({ type: "redo" })}>
          重做 Redo
        </Button>

        {doc ? (
          <Badge variant="outline" className="font-mono text-[10px]">
            {size.width}×{size.height} · {tileSize}px
          </Badge>
        ) : null}

        <span className="text-[10px] text-muted-foreground">
          ⌘/Ctrl+Z 撤销 · ⇧ 重做 · ⌘/Ctrl+S 保存 · 1/2/3 模式
        </span>

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={!doc} onClick={validate}>
            校验 Validate
          </Button>
          <Button size="sm" disabled={!doc || !dirty || saving} onClick={save}>
            {saving ? "保存中…" : "保存草稿 Save"}
          </Button>
        </div>
      </div>

      {/* Three panels. `minmax(0, …)` on both axes is load-bearing: a bare `1fr` row takes its
          minimum from the content, so the canvas (28 tiles x 48px at 2x) would expand the row and
          push the palette off the bottom of the viewport instead of scrolling inside it. */}
      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_240px] gap-2">
        {/* Hierarchy */}
        <div className="flex min-h-0 flex-col rounded-md border">
          <div className="border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            地图 Map hierarchy
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1">
            {locations.isPending ? <p className="p-2 text-xs text-muted-foreground">加载中…</p> : null}
            {locations.isError ? <p className="p-2 text-xs text-destructive">无法读取地图列表</p> : null}
            {(locations.data ?? []).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => void load(id)}
                className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs ${
                  selectedId === id ? "bg-muted font-medium" : "hover:bg-muted/60"
                }`}
              >
                <span className="truncate font-mono">{id}</span>
                {draftIds.has(id) ? (
                  <span className="ml-auto shrink-0 text-[10px] text-amber-500" title="有未发布草稿 / has a draft">
                    ●
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        {/* Canvas */}
        <div ref={canvasHostRef} className="relative min-h-0">
          {doc ? (
            <MapCanvas
              tilemap={tilemap}
              legend={legend}
              tileSize={tileSize}
              npcs={doc.npcs ?? []}
              collision={collisionRects}
              decor={Array.isArray(doc.decor) ? (doc.decor as Array<{ art?: string; tile?: [number, number] }>) : []}
              interactables={
                Array.isArray(doc.interactables)
                  ? (doc.interactables as Array<{ id?: string; tile?: [number, number] }>)
                  : []
              }
              atlas={atlasImage}
              mode={mode}
              brush={brush}
              zoom={zoom}
              selected={cursor}
              onPaint={handlePaint}
              onSelect={handleSelect}
              onRemoveNpc={handleRemoveNpc}
              onMarkerGrab={(index, clientX, clientY) => beginDrag({ kind: "marker", index }, clientX, clientY)}
              onToggleCollision={handleToggleCollision}
              tool={tool}
              onFillRect={handleFillRect}
              onFillCollision={handleFillCollision}
              onPickTile={handlePickTile}
            />
          ) : (
            <div className="flex h-full items-center justify-center rounded-md border text-xs text-muted-foreground">
              从左栏选一张地图 / pick a map on the left
            </div>
          )}
        </div>

        {/* Palette */}
        <div className="flex min-h-0 flex-col rounded-md border">
          <div className="border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            图块 Tile palette
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {frames.length === 0 ? (
              <p className="text-xs text-muted-foreground">没有图例 / this map has no legend</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {frames.map((frame) => (
                  <button
                    key={frame.char}
                    type="button"
                    title={`'${frame.char}' → [${frame.col},${frame.row}]`}
                    onPointerDown={(event) => {
                      // One gesture, two habits: press arms the brush for click-painting, and the
                      // same press starts a drag. Releasing over the canvas paints; releasing where
                      // it started just leaves the brush armed.
                      setBrush(frame.char);
                      setMode("map");
                      beginDrag({ kind: "tile", char: frame.char }, event.clientX, event.clientY);
                    }}
                    className={`touch-none select-none rounded border-2 p-0.5 ${brush === frame.char ? "border-amber-500" : "border-transparent hover:border-muted-foreground/40"}`}
                  >
                    <span
                      className="block bg-slate-950"
                      style={
                        atlasImage
                          ? {
                              width: tileSize * paletteScale,
                              height: tileSize * paletteScale,
                              backgroundImage: `url(${atlasUrl(doc?.atlas)})`,
                              backgroundSize: `${atlasImage.naturalWidth * paletteScale}px ${atlasImage.naturalHeight * paletteScale}px`,
                              backgroundPosition: `-${frame.col * tileSize * paletteScale}px -${frame.row * tileSize * paletteScale}px`,
                              imageRendering: "pixelated",
                            }
                          : { width: tileSize * paletteScale, height: tileSize * paletteScale }
                      }
                    />
                    <span className="mt-0.5 block text-center font-mono text-[10px] text-muted-foreground">
                      {frame.char}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {doc ? (
              <Button size="sm" variant="outline" className="mt-3 w-full" onClick={fillBlank}>
                填满空白 / fill blank
              </Button>
            ) : null}
          </div>
        </div>

        {/* Inspector */}
        <div className="flex min-h-0 flex-col rounded-md border">
          <div className="flex items-center gap-2 border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            检视 Inspector
            {cursor ? (
              <Badge variant="outline" className="ml-auto font-mono text-[10px]">
                [{cursor[0]},{cursor[1]}]
              </Badge>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
            {!doc ? (
              <p className="text-muted-foreground">未选择地图 / no map selected</p>
            ) : currentNpc ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{currentNpc.npc}</span>
                  <Badge variant="outline" className="text-[10px]">
                    tile [{currentNpc.tile[0]},{currentNpc.tile[1]}]
                  </Badge>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-muted-foreground" htmlFor="facing">朝向 Facing</label>
                  <select
                    id="facing"
                    className="rounded border bg-background px-2 py-1 font-mono text-xs"
                    value={currentNpc.facing ?? "down"}
                    onChange={(event) => updatePlacement({ facing: event.target.value })}
                  >
                    {["down", "left", "right", "up"].map((facing) => (
                      <option key={facing} value={facing}>{facing}</option>
                    ))}
                  </select>

                  <label className="text-muted-foreground" htmlFor="wander">游走 Wander</label>
                  <input
                    id="wander"
                    type="number"
                    min={0}
                    max={8}
                    className="w-16 rounded border bg-background px-2 py-1 font-mono text-xs"
                    value={Number(currentNpc.wander ?? 0)}
                    onChange={(event) => updatePlacement({ wander: Number(event.target.value) || 0 })}
                  />
                </div>

                <div>
                  <p className="mb-1 text-muted-foreground">
                    出现条件 Active condition <span className="text-[10px]">(JSON — 用 “条件 Builder” 视图编辑)</span>
                  </p>
                  <textarea
                    className="h-24 w-full rounded border bg-background p-2 font-mono text-[11px] leading-relaxed"
                    spellCheck={false}
                    value={JSON.stringify(currentNpc.requires ?? {}, null, 2)}
                    onChange={(event) => {
                      const text = event.target.value;
                      try {
                        const parsed: unknown = JSON.parse(text);
                        updatePlacement({ requires: parsed });
                      } catch {
                        // Partial JSON while typing is expected; commit only complete values.
                      }
                    }}
                  />
                </div>

                <div>
                  <p className="mb-1 text-muted-foreground">该状态的 LLM 人格 / persona</p>
                  <pre className="max-h-24 overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-relaxed">
                    {npcDoc
                      ? JSON.stringify(
                          {
                            role: (npcDoc["persona"] as Record<string, unknown> | undefined)?.["role"],
                            voice: (npcDoc["persona"] as Record<string, unknown> | undefined)?.["voice"],
                            states: Array.isArray(npcDoc["states"]) ? (npcDoc["states"] as unknown[]).length : 0,
                          },
                          null,
                          2,
                        )
                      : "加载中… / loading…"}
                  </pre>
                </div>

                <Button size="sm" variant="outline" onClick={() => handleRemoveNpc(currentNpc.tile[0], currentNpc.tile[1])}>
                  移除 Remove
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1">
                  <p className="text-muted-foreground">尺寸 Size</p>
                  <p className="font-mono">{size.width} × {size.height} tiles @ {tileSize}px</p>
                </div>

                <div className="space-y-1">
                  <p className="text-muted-foreground">碰撞 Collision</p>
                  <p className="font-mono">
                    {collisionRects.length} rect(s)
                    {mode === "collision" ? (
                      <span className="ml-2 text-[10px] text-amber-500">编辑中 / editing</span>
                    ) : null}
                  </p>
                  {mode === "collision" ? (
                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      点击或拖动画墙，从实心格开始则擦除
                      <br />
                      click or drag to wall · starting on a solid cell erases
                    </p>
                  ) : null}
                </div>

                {/* Name, context, ambience, spawn points, doors, exits, interactables and decor —
                    the document around the canvas, edited on the same undo stack as a brush stroke. */}
                <LocationPanel
                  doc={doc}
                  apply={apply}
                  locationIds={locations.data ?? []}
                  cursor={cursor}
                />

                {mode === "event" ? (
                  <div className="space-y-2 rounded border border-dashed p-2">
                    <p className="text-muted-foreground">放置 NPC / place an NPC</p>
                    <div className="max-h-40 overflow-auto rounded border">
                      {(npcIds.data ?? []).map((id) => (
                        <button
                          key={id}
                          type="button"
                          onPointerDown={(event) => {
                            // Same pattern as the palette: arm for click-placement, and drag for
                            // dropping straight onto the cell you mean.
                            setPlacingNpc(id);
                            beginDrag({ kind: "npc", npcId: id }, event.clientX, event.clientY);
                          }}
                          className={`block w-full touch-none select-none truncate px-2 py-1 text-left font-mono text-[11px] ${
                            placingNpc === id ? "bg-primary/20" : "hover:bg-muted/60"
                          }`}
                        >
                          {id}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      拖到画布放置 · 拖动标记可移动 · 右键删除
                      <br />
                      drag onto the canvas to place · drag a marker to move it · right-click removes
                    </p>
                  </div>
                ) : null}
              </div>
            )}

            {issues.length > 0 ? (
              <div className="mt-3 space-y-1 border-t pt-2">
                <p className="text-muted-foreground">校验问题 / issues</p>
                {issues.map((issue, index) => (
                  <p key={index} className={issue.level === "error" ? "text-destructive" : "text-amber-500"}>
                    [{issue.level}] {issue.message}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Drag ghost. `pointer-events-none` matters: the element under the cursor at release has to
          stay the canvas, or the drop resolves against the ghost itself. */}
      {dragPayload && dragPoint ? (
        <div
          className="pointer-events-none fixed z-50 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded border border-amber-400/80 bg-slate-900/90 px-1.5 py-0.5 font-mono text-[10px] text-amber-200 shadow-lg"
          style={{ left: dragPoint.x, top: dragPoint.y }}
        >
          {dragPayload.kind === "tile" ? (
            <>
              {atlasImage && dragFrame ? (
                <span
                  aria-hidden
                  style={{
                    width: tileSize,
                    height: tileSize,
                    backgroundImage: `url(${atlasUrl(doc?.atlas)})`,
                    backgroundSize: `${atlasImage.naturalWidth}px ${atlasImage.naturalHeight}px`,
                    backgroundPosition: `-${dragFrame.col * tileSize}px -${dragFrame.row * tileSize}px`,
                    imageRendering: "pixelated",
                  }}
                />
              ) : null}
              '{dragPayload.char}'
            </>
          ) : dragPayload.kind === "npc" ? (
            dragPayload.npcId
          ) : (
            "move marker"
          )}
        </div>
      ) : null}
    </div>
  );
}
