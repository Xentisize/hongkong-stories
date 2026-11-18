import { useCallback, useEffect, useRef } from "react";

import { mapSize, npcIndexAt, type MapNpc } from "@/lib/map";

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

export type EditorMode = "map" | "event";

export interface MapCanvasProps {
  tilemap: string[];
  legend: Record<string, [number, number]>;
  tileSize: number;
  npcs: MapNpc[];
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
}

/** Unknown legend characters must be visible, not silently blank. */
const UNKNOWN_TILE = "#7f1d1d";

export function MapCanvas(props: MapCanvasProps) {
  const { tilemap, legend, tileSize, npcs, atlas, mode, brush, zoom, selected } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const painting = useRef(false);
  const lastCell = useRef<string | null>(null);

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
    }

    // Selection.
    if (selected) {
      const [sx, sy] = selected;
      context.strokeStyle = mode === "event" ? "#38bdf8" : "#f59e0b";
      context.lineWidth = 2;
      context.strokeRect(sx * scale + 1, sy * scale + 1, scale - 2, scale - 2);
    }
  }, [tilemap, legend, tileSize, npcs, atlas, mode, zoom, selected, width, height]);

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

    if (mode === "map") {
      event.currentTarget.setPointerCapture(event.pointerId);
      painting.current = true;
      lastCell.current = `${x},${y}`;
      props.onPaint(x, y);
      return;
    }

    // Event mode: one press does both jobs. It selects the marker, and it arms a drag — so a click
    // selects and a press-and-release elsewhere moves, with no separate drag handle to aim at.
    const index = npcIndexAt(npcs, x, y);
    props.onSelect(x, y);
    if (index >= 0) props.onMarkerGrab(index, event.clientX, event.clientY);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!painting.current || mode !== "map") return;
    const [x, y] = cellFromEvent(event);
    if (x < 0 || y < 0 || x >= width || y >= height) return;

    // Painting repeatedly over one cell would push a snapshot per pointer event; the map helper
    // already refuses no-ops, this just avoids the round trip.
    const key = `${x},${y}`;
    if (key === lastCell.current) return;
    lastCell.current = key;
    props.onPaint(x, y);
  };

  const endStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    painting.current = false;
    lastCell.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== "event") return;
    // Right-click removes a placement — the fastest way to undo a misdrop without hunting for a
    // delete button.
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = tileSize * zoom;
    const x = Math.floor((event.clientX - rect.left) / scale);
    const y = Math.floor((event.clientY - rect.top) / scale);
    if (npcIndexAt(npcs, x, y) >= 0) props.onRemoveNpc(x, y);
  };

  return (
    <div className="h-full overflow-auto rounded-md border border-border bg-slate-950/60 p-2">
      <canvas
        ref={canvasRef}
        className={mode === "map" ? "cursor-crosshair touch-none" : "cursor-pointer touch-none"}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        onContextMenu={handleContextMenu}
      />
    </div>
  );
}
