/**
 * Anonymous sessions and per-IP daily caps (PLAN 7.5), ported from the Python backend.
 *
 * A session is the only thing the client holds: a random token and a token budget. No identity,
 * no PII, no key. In-memory on purpose — a restart invalidates sessions, which is the correct
 * behaviour for a game whose client can simply ask for a new one.
 *
 * The state lives on `globalThis` because dev-time module reloading would otherwise hand every
 * request a fresh empty Map, and because the chat route has to see the session that `/v1/session`
 * created. This is also exactly why the earlier architecture note said in-memory state pins the
 * deployment to a single instance: two processes would each keep their own Map.
 */

export interface Session {
  token: string;
  budget: number;
  ip: string;
  usedTokens: number;
  turns: number;
  createdAt: number;
}

export interface PublicSession {
  session_token: string;
  budget: number;
  remaining: number;
}

const MAX_SESSIONS = 4096;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface Store {
  sessions: Map<string, Session>;
  /** `ip|yyyy-mm-dd` → sessions created + cost accrued that day. */
  days: Map<string, { sessions: number; cost: number }>;
  today: string;
}

function store(): Store {
  const key = "__hks_sessions__";
  const holder = globalThis as unknown as Record<string, Store | undefined>;
  if (!holder[key]) {
    holder[key] = { sessions: new Map(), days: new Map(), today: "" };
  }
  return holder[key]!;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Drop yesterday's buckets so a long-running process does not grow without bound. */
function prune(state: Store): void {
  const day = today();
  if (state.today === day) return;
  state.today = day;
  for (const key of state.days.keys()) {
    if (!key.endsWith(day)) state.days.delete(key);
  }
}

function bucket(state: Store, ip: string): { sessions: number; cost: number } {
  const key = `${ip}|${today()}`;
  let slot = state.days.get(key);
  if (!slot) {
    slot = { sessions: 0, cost: 0 };
    state.days.set(key, slot);
  }
  return slot;
}

/** The client address, honouring a proxy header when one is present. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

export function sessionAllowed(ip: string): boolean {
  const state = store();
  prune(state);
  return bucket(state, ip).sessions < envInt("HKS_PER_IP_DAILY_SESSIONS", 40);
}

export function createSession(ip: string): Session | null {
  const state = store();
  prune(state);
  if (state.sessions.size >= MAX_SESSIONS) return null;

  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  const session: Session = {
    token,
    budget: envInt("HKS_SESSION_BUDGET", 60_000),
    ip,
    usedTokens: 0,
    turns: 0,
    createdAt: Date.now(),
  };

  state.sessions.set(token, session);
  bucket(state, ip).sessions += 1;
  return session;
}

export function getSession(token: string): Session | undefined {
  return store().sessions.get(token);
}

/** Remaining budget for a session. The Python original had this as a property. */
export function remainingOf(session: Session): number {
  return Math.max(0, session.budget - session.usedTokens);
}

export function asPublicSession(session: Session): PublicSession {
  return {
    session_token: session.token,
    budget: session.budget,
    remaining: remainingOf(session),
  };
}

export function chatModel(): string {
  return process.env.HKS_CHAT_MODEL ?? process.env.TEXT_GENERATION_MODEL ?? "deepseek/deepseek-v4.1-flash-1017";
}

export function chatOutputMode(): string {
  return process.env.HKS_CHAT_OUTPUT_MODE ?? "json";
}
