/* The in-game half of the preview bridge: clicks in the running game become editor selections.
 *
 * Everything the bridge needs from Phaser or the DOM is injected, so the protocol is testable
 * without an engine: give it a canvas-like target, a coordinate→tile function and a way to post,
 * and it behaves exactly as it does in the embedded client.
 */

import { eventMessage, isPreviewCommand, type PreviewEvent } from "./preview";

export interface BridgeSource {
  /** The game canvas, fetched late because Phaser creates it after boot. */
  canvas(): EventTarget | null;
  /** Client coordinates → tile, or null when the pointer is outside the map. */
  toTile(clientX: number, clientY: number): [number, number] | null;
  /** The frame's own pixel coordinates → tile. Used by the drag forwarded from the studio. */
  toLocalTile?(x: number, y: number): [number, number] | null;
  /** What stands on a tile, if anything. */
  entityAt(tile: [number, number]): { type: string; id: string } | null;
  /** The scene the game is showing right now. */
  location(): string;
  post(message: unknown): void;
  /** A placement click landed: the studio turns this tile into an edit. */
  onPick?(tile: [number, number]): void;
  onGoto?(location: string, spawn?: string): void;
  onPause?(): void;
  onResume?(): void;
}

export function attachPreviewBridge(source: BridgeSource): () => void {
  const send = (event: PreviewEvent) => source.post(eventMessage(event));

  // Placement: the studio asks "where?", the next click answers with a tile instead of a selection.
  let picking = false;
  /** The last tile reported while hovering, so a pointer inside one cell does not spam the studio. */
  let hovered: string | null = null;

  const setCursor = (value: string) => {
    const canvas = source.canvas();
    // Structural check, not `instanceof HTMLElement`: the bridge is unit-tested without a DOM.
    if (canvas !== null && "style" in canvas) (canvas as { style: { cursor: string } }).style.cursor = value;
  };
  const armPick = () => {
    picking = true;
    hovered = null;
    setCursor("crosshair");
  };
  const disarmPick = () => {
    picking = false;
    hovered = null;
    setCursor("");
  };

  /**
   * While armed, report where the pointer is.
   *
   * This is what makes placement legible before it happens: the studio can show "放喺 tile 12,7"
   * instead of asking the author to click blind. Only a *changed* tile is sent — a pointer inside
   * one cell would otherwise post on every mouse move.
   */
  /** Report a tile under the pointer/ghost, once per cell. */
  const emitHover = (tile: [number, number]) => {
    const key = `${tile[0]},${tile[1]}`;
    if (key === hovered) return;
    hovered = key;
    send({ type: "hovered", tile });
  };

  const move = (event: Event) => {
    if (!picking) return;
    const pointer = event as PointerEvent;
    const tile = source.toTile(pointer.clientX, pointer.clientY);
    if (tile !== null) emitHover(tile);
  };

  const down = (event: Event) => {
    if (picking) return; // the click is an answer to "where?", handled on release
    const pointer = event as PointerEvent;
    const tile = source.toTile(pointer.clientX, pointer.clientY);
    if (tile === null) return;
    const entity = source.entityAt(tile);
    send({
      type: "selected",
      tile,
      entityType: entity?.type ?? null,
      entityId: entity?.id ?? null,
    });
  };

  const up = (event: Event) => {
    if (!picking) return;
    const pointer = event as PointerEvent;
    const tile = source.toTile(pointer.clientX, pointer.clientY);
    if (tile === null) return;
    disarmPick();
    send({ type: "picked", tile });
    source.onPick?.(tile);
  };

  const incoming = (event: Event) => {
    const data = (event as MessageEvent).data;
    if (!isPreviewCommand(data)) return;
    if (data.type === "goto" || data.type === "playFrom") source.onGoto?.(data.location, data.spawn);
    else if (data.type === "pause") source.onPause?.();
    else if (data.type === "resume") source.onResume?.();
    else if (data.type === "pick") armPick();
    else if (data.type === "hover") {
      // A drag started in the studio: the frame is told where it is, in its own pixels.
      const tile = source.toLocalTile?.(data.x, data.y) ?? null;
      if (tile !== null) emitHover(tile);
    } else if (data.type === "place") {
      const tile = source.toLocalTile?.(data.x, data.y) ?? null;
      if (tile === null) return;
      disarmPick();
      send({ type: "picked", tile });
      source.onPick?.(tile);
    }
    else if (data.type === "select") {
      send({ type: "selected", tile: data.tile ?? null, entityType: null, entityId: data.entity ?? null });
    }
  };

  const canvas = source.canvas();
  canvas?.addEventListener("pointerdown", down);
  canvas?.addEventListener("pointerup", up);
  canvas?.addEventListener("pointermove", move);
  globalThis.addEventListener("message", incoming);
  send({ type: "ready", location: source.location() });

  return () => {
    disarmPick();
    canvas?.removeEventListener("pointerdown", down);
    canvas?.removeEventListener("pointerup", up);
    canvas?.removeEventListener("pointermove", move);
    globalThis.removeEventListener("message", incoming);
  };
}
