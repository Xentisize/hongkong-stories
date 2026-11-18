/* The game, embedded — the WYSIWYG surface of the Build place.
 *
 * It is the real Phaser client in an iframe, not a second renderer: the engine stays Phaser, the
 * admin bundle stays free of it, and what you see is what a player gets. The iframe is pointed at
 * the client with `?preview=1&token=…`, so the client loads the *draft* pack from the admin preview
 * route; this component then speaks the bridge protocol with it.
 *
 * The game's URL is configuration, not a constant: `VITE_GAME_URL` for a dev client server, and
 * `/game/` once the built client is served beside the admin.
 */

import { useEffect, useMemo, useRef, useState } from "react";

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
  pickNonce = 0,
}: {
  token: string;
  /** The scene the author picked; the frame asks the game to go there. */
  location: string | null;
  onSelect: (selection: PreviewSelection) => void;
  /** A placement click landed in the game. */
  onPick?: (tile: [number, number]) => void;
  /** Bump this to arm the next click as a placement. */
  pickNonce?: number;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState<string | null>(null);

  const src = useMemo(() => {
    const url = new URL(gameUrl(), window.location.origin);
    url.searchParams.set("preview", "1");
    if (token !== "") url.searchParams.set("token", token);
    return url.toString();
  }, [token]);

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
      } else if (event.data.type === "error") {
        setStatus("error");
        setFailure(event.data.message);
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onSelect, onPick]);

  useEffect(() => {
    if (location === null) return;
    frame.current?.contentWindow?.postMessage(commandMessage({ type: "goto", location }), "*");
  }, [location]);

  // Arming placement: the game answers the next click with a tile instead of a selection.
  useEffect(() => {
    if (pickNonce <= 0) return;
    frame.current?.contentWindow?.postMessage(commandMessage({ type: "pick" }), "*");
  }, [pickNonce]);

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
        </p>
      ) : null}

      <iframe
        ref={frame}
        src={src}
        title="preview"
        className="h-[440px] w-full rounded-md border bg-slate-950"
        // The preview needs the same origin to read the admin token aloud; nothing else is shared.
        sandbox="allow-scripts allow-same-origin allow-pointer-lock"
      />
    </div>
  );
}
