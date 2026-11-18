/* Thin typed client for the admin API (PLAN 9.2, 9.3). Every call carries the bearer
 * token; errors surface as ApiError with the server's detail so the UI can show why a
 * publish was refused instead of guessing. */

const TOKEN_KEY = "hks_admin_token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, detail: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken()}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

/** Same contract as `request`, for the two endpoints that speak markdown instead of JSON. */
async function requestText(method: string, path: string, body?: string): Promise<string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken()}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "text/markdown; charset=utf-8";
    init.body = body;
  }
  const response = await fetch(path, init);
  if (!response.ok) throw await toApiError(response);
  return response.text();
}

/** Same contract as `request`, for the endpoint that answers with an archive instead of JSON. */
async function requestBlob(method: string, path: string): Promise<Blob> {
  const response = await fetch(path, { method, headers: { Authorization: `Bearer ${getToken()}` } });
  if (!response.ok) throw await toApiError(response);
  return response.blob();
}

async function toApiError(response: Response): Promise<ApiError> {
  let detail: unknown = response.statusText;
  try {
    const parsed = await response.json();
    detail = parsed?.detail ?? parsed;
  } catch {
    // keep statusText
  }
  return new ApiError(response.status, detail);
}

export const api = {
  meta: () => request("GET", "/v1/admin/meta"),
  drafts: () => request("GET", "/v1/admin/drafts"),
  getDraft: (kind: string, id: string) => request("GET", `/v1/admin/drafts/${kind}/${id}`),
  putDraft: (kind: string, id: string, body: unknown) =>
    request("PUT", `/v1/admin/drafts/${kind}/${id}`, body),
  deleteDraft: (kind: string, id: string) => request("DELETE", `/v1/admin/drafts/${kind}/${id}`),
  entities: (kind: string) => request("GET", `/v1/admin/content/${kind}`),
  entity: (kind: string, id: string) => request("GET", `/v1/admin/content/${kind}/${id}`),
  /** Lore pages are markdown, so they are read and written as text rather than as entities. */
  loreBaseline: (id: string) => requestText("GET", `/v1/admin/content/lore/${encodeURIComponent(id)}`),
  loreDraft: (id: string) => requestText("GET", `/v1/admin/drafts/lore/${encodeURIComponent(id)}`),
  putLoreDraft: (id: string, text: string) =>
    requestText("PUT", `/v1/admin/drafts/lore/${encodeURIComponent(id)}`, text),
  validate: () => request("POST", "/v1/admin/validate"),
  publish: () => request("POST", "/v1/admin/publish"),
  /** The whole game as one archive: `game.json` + pack + every media file, hashed. */
  exportBundle: () => requestBlob("GET", "/v1/admin/bundle"),
  artTemplates: () => request("GET", "/v1/admin/art/templates"),
  generateArt: (body: unknown) => request("POST", "/v1/admin/art/generate", body),
  evaluateCondition: (body: unknown) => request("POST", "/v1/admin/evaluate_condition", body),
  publishPreview: () => request("GET", "/v1/admin/publish_preview"),
  playground: (body: unknown) => request("POST", "/v1/admin/playground", body),
  factcheckList: () => request("GET", "/v1/admin/factcheck"),
  factcheckCheck: (body: unknown) => request("POST", "/v1/admin/factcheck/check", body),
  factcheckResolve: (id: string, status: string) =>
    request("POST", `/v1/admin/factcheck/${id}/resolve`, { status }),
  usage: () => request("GET", "/v1/admin/usage"),
};

export type DraftSummary = { kind: string; id: string; updated: number };
export type Issue = { level: string; path: string; message: string };
export type UsageSummary = {
  month: string;
  chat_cost_usd: number;
  image_cost_usd: number;
  factcheck_cost_usd?: number;
  turns: number;
  tokens: number;
  p95_latency_ms: number;
  top_rejected: Array<{ reason: string; count: number }>;
  sessions: Array<{ session: string; turns: number; cost_usd: number }>;
};
export type FactEntry = {
  id: string;
  ts: string;
  npc_id: string;
  player_input: string;
  reply: string;
  verdict: string;
  reason: string;
  status: string;
  cost_usd: number;
};
export type PlaygroundTurn = {
  say: string;
  mood: string;
  actions: unknown[];
  rejected: Array<{ action: unknown; reason: string }>;
  truncated: boolean;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    cache_ratio: number;
    cost_usd: number;
  };
  latency_ms: number;
  model: string;
};
