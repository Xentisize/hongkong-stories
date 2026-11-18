import { ApiError } from "@/api";

/**
 * Turn an API failure into something an operator can act on.
 *
 * The server returns `{detail}` for refusals (a publish rejected with a list of validation
 * issues is the important case), so the detail is the useful part and the status alone is not.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const detail =
      typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail, null, 2);
    return `${error.message}: ${detail}`;
  }
  return String(error);
}
