/* The game, embedded — the WYSIWYG surface of the Build place.
 *
 * It is the real Phaser client in an iframe, not a second renderer: the engine stays Phaser, the
 * admin bundle stays free of it, and what you see is what a player gets. The frame is opened with
 * `?preview=1` and the admin token is handed over by `postMessage` once it loads — never in the URL,
 * where a bearer credential would end up in history, the referrer and the iframe's own address.
 *
 * The game's URL is configuration, not a constant: `VITE_GAME_URL` for a dev client server, and
 * `/game/` once the built client is served beside the admin.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { commandMessage, isPreviewEvent } from "@hkstories/core";

import { Badge } from "@/components/ui/badge";

export interface PreviewSelection {
  tile: [number, number] | null;
  entityType: string | null;
  entityId: string | null;
}

/** Where the game is served. Dev points it at the client's own Vite server. */
export function gameUrl(): string {
  const configured = import.meta.env["VITE_GAME_URL"] as string | undefined;
  return configured && configured.trim() !== "" ? configured : "/game/";
}

export function PreviewFrame({
  token,
  location,
  onSelect,
  onPick,
  onHover,
  dragPoint = null,
  dropNonce = 0,
  pickNonce = 0,
}: {
  token: string;
  /** The scene the author picked; the frame asks the game to go there. */
  location: string | null;
  onSelect: (selection: PreviewSelection) => void;
  /** A placement click landed in the game. */
  onPick?: (tile: [number, number]) => void;
  /** Where the pointer is while placement is armed — so the author sees the landing before the click. */
  onHover?: (tile: [number, number]) => void;
  /**
   * A palette drag in progress: client coordinates of the pointer. The frame converts them to its own
   * pixels and asks the game where that is — a pointer captured in the studio is invisible to a
   * cross-origin frame, so the drag has to be forwarded rather than delivered.
   */
  dragPoint?: { clientX: number; clientY: number } | null;
  /** Bumped on release: the frame places whatever the drag was over. */
  dropNonce?: number;
  /** Bump this to arm the next click as a placement. */
  pickNonce?: number;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState<string | null>(null);

  const src = useMemo(() => {
    const url = new URL(gameUrl(), window.location.origin);
    url.searchParams.set("preview", "1");
    return url.toString();
  }, []);

  /** Only the game's own origin may receive our messages. */
  const targetOrigin = useMemo(() => new URL(gameUrl(), window.location.origin).origin, []);

  /** Hand the token over once the frame is live; the client waits for it before fetching. */
  const handOverToken = useCallback(() => {
    if (token === "") return;
    frame.current?.contentWindow?.postMessage(commandMessage({ type: "auth", token }), targetOrigin);
  }, [token, targetOrigin]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isPreviewEvent(event.data)) return;
      if (event.data.type === "ready") {
        setStatus("ready");
        setFailure(null);
      } else if (event.data.type === "selected") {
        onSelect({ tile: event.data.tile, entityType: event.data.entityType, entityId: event.data.entityId });
      } else if (event.data.type === "picked") {
        onPick?.(event.data.tile);
      } else if (event.data.type === "hovered") {
        if (event.data.tile !== null) onHover?.(event.data.tile);
      } else if (event.data.type === "error") {
        setStatus("error");
        setFailure(event.data.message);
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onSelect, onPick, onHover]);

  useEffect(() => {
    if (location === null) return;
    frame.current?.contentWindow?.postMessage(commandMessage({ type: "goto", location }), targetOrigin);
  }, [location, targetOrigin]);

  /** The pointer's position inside the frame, in the frame's own pixels. */
  const localPoint = (): { x: number; y: number } | null => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect || dragPoint === null) return null;
    const x = dragPoint.clientX - rect.left;
    const y = dragPoint.clientY - rect.top;
    // Outside the frame: nothing to ask about, and negative coordinates would map to garbage tiles.
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    return { x, y };
  };

  useEffect(() => {
    const point = localPoint();
    if (point === null) return;
    frame.current?.contentWindow?.postMessage(commandMessage({ type: "hover", ...point }), targetOrigin);
    // `localPoint` reads dragPoint; the rest is stable for a given frame.
  }, [dragPoint, targetOrigin]);

  const lastDrag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const point = localPoint();
    if (point !== null) lastDrag.current = point;
  }, [dragPoint]);

  useEffect(() => {
    if (dropNonce <= 0) return;
    const point = lastDrag.current;
    lastDrag.current = null;
    if (point === null) return;
    frame.current?.contentWindow?.postMessage(commandMessage({ type: "place", ...point }), targetOrigin);
  }, [dropNonce, targetOrigin]);

  // Arming placement: the game answers the next click with a tile instead of a selection.
  useEffect(() => {
    if (pickNonce <= 0) return;
    frame.current?.contentWindow?.postMessage(commandMessage({ type: "pick" }), targetOrigin);
  }, [pickNonce, targetOrigin]);

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium">遊戲畫面 / the game</p>
        <Badge variant={status === "ready" ? "secondary" : "outline"} className="text-[9px]">
          {status === "ready" ? "已連線 live" : status === "error" ? "出錯 error" : "載入中 loading"}
        </Badge>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{src}</span>
      </div>

      {failure !== null ? (
        <p className="rounded border border-destructive/40 p-2 text-[11px] text-destructive">
          {failure}
          <br />
          睇緊嘅係已發佈內容，唔係你嘅草稿。/ you are looking at the published pack, not your draft.
        </p>
      ) : null}

      <iframe
        ref={frame}
        src={src}
        title="preview"
        onLoad={handOverToken}
        className="h-[440px] w-full rounded-md border bg-slate-950"
        // The game needs its own origin for the panel's DOM and pointer events; nothing else is shared.
        sandbox="allow-scripts allow-same-origin allow-pointer-lock"
      />
    </div>
  );
}
