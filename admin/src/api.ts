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
  if (!response.ok) {
    let detail: unknown = response.statusText;
    try {
      const parsed = await response.json();
      detail = parsed?.detail ?? parsed;
    } catch {
      // keep statusText
    }
    throw new ApiError(response.status, detail);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
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
  validate: () => request("POST", "/v1/admin/validate"),
  publish: () => request("POST", "/v1/admin/publish"),
  generateArt: (body: unknown) => request("POST", "/v1/admin/art/generate", body),
};

export type DraftSummary = { kind: string; id: string; updated: number };
export type Issue = { level: string; path: string; message: string };
