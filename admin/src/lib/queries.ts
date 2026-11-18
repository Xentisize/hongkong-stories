/* Typed TanStack Query bindings over the existing admin API client (PLAN 9.2).
 *
 * `api.ts` is unchanged: the fetch/bearer-token contract still lives there and still returns
 * `unknown`. This module is the single place that names those responses, so a server shape
 * change surfaces as one type error here instead of as `as any` scattered across the views.
 *
 * Query keys include the token. The admin has no login session — an operator pastes a token —
 * so a token change must invalidate everything rather than silently reuse another token's
 * cached drafts. */

import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  api,
  type DraftSummary,
  type FactEntry,
  type Issue,
  type UsageSummary,
} from "@/api";
import { asLocalized } from "@/lib/localized";

export interface Meta {
  content_version: number;
  content_hash: string;
  counts: Record<string, number>;
}

export interface ValidateResult {
  ok: boolean;
  issues: Issue[];
}

export interface PublishPreview {
  added: Array<{ kind: string; id: string }>;
  changed: Array<{ kind: string; id: string }>;
}

export interface PublishResult {
  published: number;
  version: number;
  content_hash: string;
}

export type Entity = Record<string, unknown>;

export const queryKeys = {
  meta: (token: string) => ["meta", token] as const,
  gameTitle: (token: string) => ["game-title", token] as const,
  drafts: (token: string) => ["drafts", token] as const,
  entities: (token: string, kind: string) => ["entities", token, kind] as const,
  usage: (token: string) => ["usage", token] as const,
  factcheck: (token: string) => ["factcheck", token] as const,
};

/**
 * The game's name, from the one settings document a pack is allowed to have.
 *
 * That document already carries the title (and so does the bundle's `game.json`), which is why the
 * header can say *which* game this is without inventing a second project file. Baseline rather
 * than draft: the header describes the game as it currently ships, and a half-typed draft title
 * would make the admin's own identity flicker.
 */
export function useGameTitle(token: string) {
  return useQuery({
    queryKey: queryKeys.gameTitle(token),
    queryFn: async () => {
      const doc = (await api.entity("settings", "game")) as Entity;
      const title = asLocalized(doc["title"]);
      return title["zh_HK"] ?? title["en"] ?? String(doc["id"] ?? "");
    },
  });
}

export function useMeta(token: string) {
  return useQuery({
    queryKey: queryKeys.meta(token),
    queryFn: () => api.meta() as Promise<Meta>,
  });
}

export function useDrafts(token: string) {
  return useQuery({
    queryKey: queryKeys.drafts(token),
    queryFn: () => api.drafts() as Promise<DraftSummary[]>,
  });
}

/** Baseline ids of one content kind — the "clone from here" list in the editor sidebar. */
export function useEntityIds(token: string, kind: string) {
  return useQuery({
    queryKey: queryKeys.entities(token, kind),
    queryFn: () => api.entities(kind) as Promise<{ entities: string[] }>,
    select: (data) => data.entities,
  });
}

/**
 * Every id of a kind that the editor can open: baseline documents **plus** draft-only ones.
 *
 * A document created in the editor has no baseline file until it is published, so the baseline list
 * alone would omit the thing the author just made — which reads as "the create button did nothing".
 * The union is what the sidebar, the exits' target picker and the chapter pickers all want.
 */
export function useKindIds(token: string, kind: string) {
  const baseline = useEntityIds(token, kind);
  const drafts = useDrafts(token);

  const ids = useMemo(() => {
    const merged = new Set<string>(baseline.data ?? []);
    for (const draft of drafts.data ?? []) {
      if (draft.kind === kind) merged.add(draft.id);
    }
    return [...merged].sort();
  }, [baseline.data, drafts.data, kind]);

  return {
    data: baseline.data === undefined && drafts.data === undefined ? undefined : ids,
    isPending: baseline.isPending || drafts.isPending,
    isError: baseline.isError || drafts.isError,
    refetch: baseline.refetch,
  };
}

export function useUsage(token: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.usage(token),
    queryFn: () => api.usage() as Promise<UsageSummary>,
    enabled,
  });
}

export function useFactcheckQueue(token: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.factcheck(token),
    queryFn: () => api.factcheckList() as Promise<FactEntry[]>,
    enabled,
  });
}

/**
 * Everything that can change the content pack: drafts, baseline ids, the manifest, and the
 * dashboards that read the usage ledger. Publishing bumps the version, so it invalidates all
 * of it rather than one list.
 */
export function useRefreshContent(token: string) {
  const client = useQueryClient();
  return () => {
    for (const key of [
      queryKeys.meta(token),
      queryKeys.gameTitle(token),
      queryKeys.drafts(token),
      queryKeys.entities(token, "npcs"),
      queryKeys.usage(token),
      queryKeys.factcheck(token),
    ]) {
      void client.invalidateQueries({ queryKey: key });
    }
  };
}
