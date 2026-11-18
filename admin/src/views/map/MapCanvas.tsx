import { useCallback, useEffect, useRef, useState } from "react";

import { collisionGrid, mapSize, npcIndexAt, solidAt, type CollisionRect, type MapNpc } from "@/lib/map";

/**
 * The map canvas.
 *
 * Draws the tilemap straight from the atlas image — one `drawImage` per cell — so the editor shows
 * the real art rather than coloured rectangles. Tiles are drawn at integer scale factors with
 * image smoothing off; a 24px tile scaled by a fractional factor turns to mush and stops reading as
 * pixel art.
 *
 * Pointer beats mouse events here: `setPointerCapture` keeps a drag alive when the cursor leaves the
 * canvas, which is what makes drag-painting usable near the edges.
 */

export type EditorMode = "map" | "event" | "collision";

/** How a press behaves: lay cells down one at a time, or drag out a rectangle. */
export type EditorTool = "brush" | "rect";

export interface MapCanvasProps {
  tilemap: string[];
  legend: Record<string, [number, number]>;
  tileSize: number;
  npcs: MapNpc[];
  collision: CollisionRect[];
  /** Set dressing — drawn as hollow squares in event mode, so overlap is visible. */
  decor: Array<{ art?: string; tile?: [number, number] }>;
  /** Pressable objects — drawn as diamonds in event mode. */
  interactables: Array<{ id?: string; tile?: [number, number] }>;
  atlas: HTMLImageElement | null;
  mode: EditorMode;
  /** Character written in map mode. */
  brush: string;
  zoom: number;
  selected: [number, number] | null;
  onPaint: (x: number, y: number) => void;
  onSelect: (x: number, y: number) => void;
  onRemoveNpc: (x: number, y: number) => void;
  /** A press landed on an existing marker: the caller decides whether that becomes a drag. */
  onMarkerGrab: (index: number, clientX: number, clientY: number) => void;
  onToggleCollision: (x: number, y: number, solid: boolean) => void;
  /** Active tool: a free brush, or drag-a-rectangle. */
  tool: EditorTool;
  onFillRect: (x0: number, y0: number, x1: number, y1: number) => void;
  onFillCollision: (x0: number, y0: number, x1: number, y1: number, solid: boolean) => void;
  /** Eyedropper: take the tile under the cursor as the brush. */
  onPickTile: (x: number, y: number) => void;
}

/** Unknown legend characters must be visible, not silently blank. */
const UNKNOWN_TILE = "#7f1d1d";

export function MapCanvas(props: MapCanvasProps) {
  const {
    tilemap,
    legend,
    tileSize,
    npcs,
    collision,
    decor,
    interactables,
    atlas,
    mode,
    brush,
    zoom,
    selected,
    tool,
  } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const painting = useRef(false);
  const lastCell = useRef<string | null>(null);
  /** Whether this collision stroke lays walls down or takes them away; decided once per press. */
  const collisionSolid = useRef(true);

  // Overlays are DOM elements rather than canvas drawing: a redraw per pointer move over a whole
  // map is wasted work when a positioned div shows the same thing.
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [rectStart, setRectStart] = useState<[number, number] | null>(null);
  const [rectEnd, setRectEnd] = useState<[number, number] | null>(null);

  const { width, height } = mapSize(tilemap);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scale = tileSize * zoom;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.max(1, Math.round(width * scale * dpr));
    canvas.height = Math.max(1, Math.round(height * scale * dpr));
    canvas.style.width = `${width * scale}px`;
    canvas.style.height = `${height * scale}px`;

    const context = canvas.getContext("2d");
    if (!context) return;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, width * scale, height * scale);

    // Tiles.
    for (let y = 0; y < height; y += 1) {
      const row = tilemap[y] ?? "";
      for (let x = 0; x < width; x += 1) {
        const char = row[x];
        const frame = char === undefined ? undefined : legend[char];

        if (char === undefined) continue; // ragged row: leave it empty rather than inventing a tile
        if (!frame || !atlas) {
          context.fillStyle = UNKNOWN_TILE;
          context.fillRect(x * scale, y * scale, scale, scale);
          continue;
        }

        context.drawImage(
          atlas,
          frame[0] * tileSize,
          frame[1] * tileSize,
          tileSize,
          tileSize,
          x * scale,
          y * scale,
          scale,
          scale,
        );
      }
    }

    // Grid, so a cell is targetable at low zoom.
    if (zoom >= 1.5) {
      context.strokeStyle = "rgba(255,255,255,0.10)";
      context.lineWidth = 1;
      for (let x = 1; x < width; x += 1) {
        context.beginPath();
        context.moveTo(x * scale + 0.5, 0);
        context.lineTo(x * scale + 0.5, height * scale);
        context.stroke();
      }
      for (let y = 1; y < height; y += 1) {
        context.beginPath();
        context.moveTo(0, y * scale + 0.5);
        context.lineTo(width * scale, y * scale + 0.5);
        context.stroke();
      }
    }

    // Collision: dim the art, then mark the solids. Without the dim it is hard to tell a painted
    // wall from a solid one at 1:1, which is exactly the confusion this mode exists to fix.
    if (mode === "collision") {
      context.fillStyle = "rgba(2,6,23,0.55)";
      context.fillRect(0, 0, width * scale, height * scale);

      const solid = collisionGrid(collision, width, height);
      context.fillStyle = "rgba(239,68,68,0.55)";
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (solid[y]?.[x] === true) context.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }

    // Events: markers sit on top of the tiles and are only drawn in event mode, so the two views
    // stay distinguishable at a glance.
    if (mode === "event") {
      for (const entry of npcs) {
        const [nx, ny] = entry.tile;
        const cx = nx * scale + scale / 2;
        const cy = ny * scale + scale / 2;
        const radius = Math.max(6, scale * 0.34);

        context.beginPath();
        context.arc(cx, cy, radius, 0, Math.PI * 2);
        context.fillStyle = "rgba(56,189,248,0.85)";
        context.fill();
        context.strokeStyle = "rgba(8,47,73,0.9)";
        context.lineWidth = 2;
        context.stroke();

        context.fillStyle = "#082f49";
        context.font = `${Math.max(9, Math.round(scale * 0.42))}px ui-sans-serif, system-ui`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(entry.npc.replace(/^npc_/, "").slice(0, 3), cx, cy);
      }

      // Set dressing and pressable objects get their own shapes, hollow so a cell carrying one of
      // each — or one of each plus an NPC — stays readable. Without them the only way to find an
      // object is to read the inspector list and count cells.
      for (const entry of decor) {
        if (!Array.isArray(entry.tile)) continue;
        const [dx, dy] = entry.tile;
        const pad = Math.max(2, scale * 0.22);
        context.strokeStyle = "rgba(52,211,153,0.9)";
        context.lineWidth = Math.max(1, scale * 0.07);
        context.strokeRect(dx * scale + pad, dy * scale + pad, scale - pad * 2, scale - pad * 2);
      }

      for (const entry of interactables) {
        if (!Array.isArray(entry.tile)) continue;
        const [ix, iy] = entry.tile;
        const cx = ix * scale + scale / 2;
        const cy = iy * scale + scale / 2;
        const radius = Math.max(4, scale * 0.26);

        context.beginPath();
        context.moveTo(cx, cy - radius);
        context.lineTo(cx + radius, cy);
        context.lineTo(cx, cy + radius);
        context.lineTo(cx - radius, cy);
        context.closePath();
        context.strokeStyle = "rgba(251,191,36,0.95)";
        context.lineWidth = Math.max(1, scale * 0.09);
        context.stroke();
      }
    }

    // Selection.
    if (selected) {
      const [sx, sy] = selected;
      context.strokeStyle = mode === "event" ? "#38bdf8" : "#f59e0b";
      context.lineWidth = 2;
      context.strokeRect(sx * scale + 1, sy * scale + 1, scale - 2, scale - 2);
    }
  }, [tilemap, legend, tileSize, npcs, collision, decor, interactables, atlas, mode, zoom, selected, width, height]);

  useEffect(draw, [draw]);

  const cellFromEvent = (event: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = tileSize * zoom;
    return [
      Math.floor((event.clientX - rect.left) / scale),
      Math.floor((event.clientY - rect.top) / scale),
    ];
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = cellFromEvent(event);
    if (x < 0 || y < 0 || x >= width || y >= height) return;

    // Eyedropper: Alt+click picks the tile under the cursor, the way Aseprite does.
    if (mode === "map" && event.altKey) {
      props.onPickTile(x, y);
      return;
    }

    if (tool === "rect" && (mode === "map" || mode === "collision")) {
      event.currentTarget.setPointerCapture(event.pointerId);
      // Collision rectangles keep the same once-per-stroke rule as cells: the first cell decides
      // whether the rectangle walls or clears.
      if (mode === "collision") collisionSolid.current = !solidAt(collision, x, y);
      setRectStart([x, y]);
      setRectEnd([x, y]);
      return;
    }

    if (mode === "map") {
      event.currentTarget.setPointerCapture(event.pointerId);
      painting.current = true;
      lastCell.current = `${x},${y}`;
      props.onPaint(x, y);
      return;
    }

    if (mode === "collision") {
      event.currentTarget.setPointerCapture(event.pointerId);
      painting.current = true;
      // The stroke's direction is decided once, from the first cell: starting on open floor lays
      // walls down, starting on a wall takes them away. Deciding per cell would toggle on every
      // move and leave a checkerboard behind the cursor.
      collisionSolid.current = !solidAt(collision, x, y);
      lastCell.current = `${x},${y}`;
      props.onToggleCollision(x, y, collisionSolid.current);
      return;
    }

    // Event mode: one press does both jobs. It selects the marker, and it arms a drag — so a click
    // selects and a press-and-release elsewhere moves, with no separate drag handle to aim at.
    const index = npcIndexAt(npcs, x, y);
    props.onSelect(x, y);
    if (index >= 0) props.onMarkerGrab(index, event.clientX, event.clientY);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const [rawX, rawY] = cellFromEvent(event);
    const inside = rawX >= 0 && rawY >= 0 && rawX < width && rawY < height;

    // Hover is a cursor aid: update it only when the cell actually changes, and drop it off-map.
    setHover((current) => {
      const next: [number, number] | null = inside ? [rawX, rawY] : null;
      if (current === null && next === null) return current;
      if (current !== null && next !== null && current[0] === next[0] && current[1] === next[1]) {
        return current;
      }
      return next;
    });

    if (rectStart) {
      setRectEnd(inside ? [rawX, rawY] : null);
      return;
    }

    if (!painting.current) return;
    if (mode !== "map" && mode !== "collision") return;
    if (!inside) return;

    // Painting repeatedly over one cell would push a snapshot per pointer event; the map helpers
    // already refuse no-ops, this just avoids the round trip.
    const key = `${rawX},${rawY}`;
    if (key === lastCell.current) return;
    lastCell.current = key;

    if (mode === "map") props.onPaint(rawX, rawY);
    else props.onToggleCollision(rawX, rawY, collisionSolid.current);
  };

  const handlePointerLeave = () => setHover(null);

  const endStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    painting.current = false;
    lastCell.current = null;

    if (rectStart) {
      const [x, y] = cellFromEvent(event);
      const endX = Math.min(width - 1, Math.max(0, x));
      const endY = Math.min(height - 1, Math.max(0, y));

      if (mode === "map") props.onFillRect(rectStart[0], rectStart[1], endX, endY);
      else if (mode === "collision") {
        props.onFillCollision(rectStart[0], rectStart[1], endX, endY, collisionSolid.current);
      }

      setRectStart(null);
      setRectEnd(null);
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    // The editor canvas has no browser menu to offer.
    event.preventDefault();

    const rect = event.currentTarget.getBoundingClientRect();
    const scale = tileSize * zoom;
    const x = Math.floor((event.clientX - rect.left) / scale);
    const y = Math.floor((event.clientY - rect.top) / scale);

    if (mode === "map") {
      // Right-click doubles as the eyedropper — the quickest way to match an adjacent tile.
      if (x >= 0 && y >= 0 && x < width && y < height) props.onPickTile(x, y);
      return;
    }

    if (mode !== "event") return;
    if (npcIndexAt(npcs, x, y) >= 0) props.onRemoveNpc(x, y);
  };

  const cellPx = tileSize * zoom;
  const rectBox =
    rectStart && rectEnd
      ? {
          left: Math.min(rectStart[0], rectEnd[0]) * cellPx,
          top: Math.min(rectStart[1], rectEnd[1]) * cellPx,
          width: (Math.abs(rectStart[0] - rectEnd[0]) + 1) * cellPx,
          height: (Math.abs(rectStart[1] - rectEnd[1]) + 1) * cellPx,
        }
      : null;

  return (
    <div className="h-full overflow-auto rounded-md border border-border bg-slate-950/60 p-2">
      {/* The wrapper gives the overlays a canvas-sized box to sit in. */}
      <div className="relative" style={{ width: width * cellPx, height: height * cellPx }}>
        <canvas
          ref={canvasRef}
          className={`touch-none ${tool === "rect" ? "cursor-cell" : mode === "map" ? "cursor-crosshair" : "cursor-pointer"}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={handlePointerLeave}
          onContextMenu={handleContextMenu}
        />

        {hover && !rectBox ? (
          <div
            className="pointer-events-none absolute border border-amber-400/80"
            style={{ left: hover[0] * cellPx, top: hover[1] * cellPx, width: cellPx, height: cellPx }}
          />
        ) : null}

        {rectBox ? (
          <div
            className="pointer-events-none absolute border-2 border-sky-400 bg-sky-400/20"
            style={rectBox}
          />
        ) : null}
      </div>
    </div>
  );
}
