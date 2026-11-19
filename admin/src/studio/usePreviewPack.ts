/* One way to read the pack the author is editing.
 *
 * Three places needed this (Story, Pack › Connections, the wizard) and each grew its own copy of the
 * shape and its own query key — one of which forgot the token, so a panel could be served the pack
 * cached *before* connecting. Keying on the token is what makes "connected as someone else" refetch
 * instead of showing the previous session's content.
 */

import { useQuery } from "@tanstack/react-query";

import { api } from "@/api";

export interface PreviewPack {
  tables: Record<string, Record<string, unknown>>;
  issues: Array<{ level: string; path: string; message: string }>;
}

export function usePreviewPack(token: string) {
  return useQuery({
    queryKey: ["preview-pack", token] as const,
    queryFn: () => api.previewPack() as Promise<PreviewPack>,
    // Without a token there is nothing to ask with; firing anyway would 401 before the author connects.
    enabled: token !== "",
    // A draft changes under this panel all the time; a cached copy is the stale one.
    staleTime: 0,
  });
}
