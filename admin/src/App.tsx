/* The admin entry point.
 *
 * Everything lives in the studio now — four places, one question each. This file keeps only what is
 * genuinely global: the token, the unsaved badge, the archive export and the status line. The old
 * eleven-tab shell is gone; each of its views was re-homed into a place (Pack: characters, items,
 * lore, art; Ship: checklist, review, settings, conditions).
 */

import { useCallback, useState } from "react";
import { toast } from "sonner";

import { api, getToken, setToken } from "@/api";
import { describeError } from "@/lib/errors";
import { useGameTitle, useMeta } from "@/lib/queries";
import { Studio } from "@/studio/Studio";

export function App() {
  const [token, setTokenState] = useState(() => getToken());
  const [dirty, setDirty] = useState(false);
  const [exporting, setExporting] = useState(false);

  const meta = useMeta(token);
  const gameTitle = useGameTitle(token);

  /**
   * Download the whole game as one archive.
   *
   * The server builds it (and refuses an incomplete one), so this only has to turn the response into
   * a file. Downloaded through an anchor rather than `window.open` so the bearer header survives — a
   * plain navigation would drop the credential and get a 401.
   */
  const exportBundle = useCallback(async () => {
    setExporting(true);
    try {
      const blob = await api.exportBundle();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "game.zip";
      link.click();
      URL.revokeObjectURL(url);
      toast.success(`已匯出 ${(blob.size / 1024 / 1024).toFixed(1)} MiB / bundle downloaded`);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setExporting(false);
    }
  }, []);

  // The API client reads the token from localStorage on every call, so connecting is: persist, then
  // let the query key change drive the refetch.
  const connect = useCallback((next: string) => {
    const trimmed = next.trim();
    setToken(trimmed);
    setTokenState(trimmed);
  }, []);

  const status = meta.isError
    ? "未連接後端 / backend unreachable"
    : meta.isPending
      ? "連接中…"
      : `${gameTitle.data ? `${gameTitle.data} · ` : ""}content v${meta.data.content_version} (${
          meta.data.content_hash
        }) · npcs ${meta.data.counts["npcs"] ?? 0}`;

  return (
    <Studio
      token={token}
      onConnect={connect}
      dirty={dirty}
      onDirtyChange={setDirty}
      status={status}
      exporting={exporting}
      onExport={() => void exportBundle()}
    />
  );
}
