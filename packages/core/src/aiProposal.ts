/* What the co-pilot is allowed to return.
 *
 * The AI never writes files. It returns a **proposal**: the steps it intends (the chain of thought
 * the author reads before approving) and the whole documents it would write. The studio then applies
 * those documents through the ordinary draft path — so an AI edit is validated, undoable and
 * publishable exactly like a hand-typed one, and a bad proposal is simply not applied.
 *
 * Documents rather than patches, deliberately: a hobbyist is approving "this is the street I asked
 * for", not a merge. Whole documents are also what makes the approval card honest — the diff the
 * studio shows is the difference between two documents, not a replayed edit script.
 */

export type ProposalOp = "create" | "update";

/** The entity kinds a proposal may touch. */
export const PROPOSAL_KINDS = ["locations", "npcs", "items", "quests", "chapters", "lore", "settings"] as const;

export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export interface ProposalChange {
  kind: ProposalKind;
  id: string;
  op: ProposalOp;
  /** The document to write, complete. */
  doc: Record<string, unknown>;
  /** One line for the approval card, in the author's words rather than the schema's. */
  summary: string;
}

export interface Proposal {
  /** Ordered steps: what it is about to do and why. This is the reasoning the card shows. */
  plan: string[];
  changes: ProposalChange[];
}

function isKind(value: unknown): value is ProposalKind {
  return typeof value === "string" && (PROPOSAL_KINDS as readonly string[]).includes(value);
}

function isOp(value: unknown): value is ProposalOp {
  return value === "create" || value === "update";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read a proposal out of whatever the model produced.
 *
 * Anything malformed is dropped rather than repaired: a change without an id, a document or a known
 * kind cannot be applied safely, and a plan with no surviving changes has nothing to approve — both
 * come back as `null`, which the studio shows as "nothing to do" instead of an empty card.
 */
export function parseProposal(raw: unknown): Proposal | null {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }

  const body = record(value);
  if (body === null) return null;

  const plan = Array.isArray(body["plan"])
    ? body["plan"].filter((step): step is string => typeof step === "string" && step.trim() !== "")
    : [];

  const changes: ProposalChange[] = [];
  for (const entry of Array.isArray(body["changes"]) ? body["changes"] : []) {
    const change = record(entry);
    if (change === null) continue;
    const kind = change["kind"];
    const op = change["op"] ?? "update";
    const id = typeof change["id"] === "string" ? change["id"].trim() : "";
    const doc = record(change["doc"]);
    if (!isKind(kind) || !isOp(op) || id === "" || doc === null) continue;
    const summary = typeof change["summary"] === "string" && change["summary"].trim() !== ""
      ? change["summary"].trim()
      : `${op} ${kind}/${id}`;
    changes.push({ kind, id, op, doc, summary });
  }

  if (changes.length === 0) return null;
  return {
    plan: plan.length > 0 ? plan : ["（模型未提供步驟 / the model gave no steps）"],
    changes,
  };
}

/** The one-line list the approval card renders, so two changes cannot hide behind one heading. */
export function describeProposal(proposal: Proposal): string[] {
  return proposal.changes.map((change) => `${change.op === "create" ? "＋" : "✎"} ${change.kind}/${change.id} — ${change.summary}`);
}
