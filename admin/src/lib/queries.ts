/* Typed TanStack Query bindings over the existing admin API client (PLAN 9.2).
 *
 * `api.ts` is unchanged: the fetch/bearer-token contract still lives there and still returns
 * `unknown`. This module is the single place that names those responses, so a server shape
 * change surfaces as one type error here instead of as `as any` scattered across the views.
 *
 * Query keys include the token. The admin has no login session — an operator pastes a token —
 * so a token change must invalidate everything rather than silently reuse another token's
 * cached drafts. */

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  api,
  type DraftSummary,
  type FactEntry,
  type Issue,
  type UsageSummary,
} from "@/api";

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
  drafts: (token: string) => ["drafts", token] as const,
  entities: (token: string, kind: string) => ["entities", token, kind] as const,
  usage: (token: string) => ["usage", token] as const,
  factcheck: (token: string) => ["factcheck", token] as const,
};

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
      queryKeys.drafts(token),
      queryKeys.entities(token, "npcs"),
      queryKeys.usage(token),
      queryKeys.factcheck(token),
    ]) {
      void client.invalidateQueries({ queryKey: key });
    }
  };
}
