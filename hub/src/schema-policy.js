import { HttpError } from "./auth.js";
import { isPositiveInt } from "./validate.js";

// What a client that sends no ?schema= understands: every client shipped
// before the parameter existed reads schema 1 and nothing else.
export const DEFAULT_CLIENT_SCHEMA = 1;

export const POLICY_CURRENT = "current";
const COMPAT_OK = "ok";
const POSITIVE_INT_PATTERN = /^[1-9]\d*$/;

export function parsePositiveInt(raw) {
  if (typeof raw !== "string" || !POSITIVE_INT_PATTERN.test(raw)) return null;
  const n = Number(raw);
  return isPositiveInt(n) ? n : null;
}

export function parseClientSchema(url) {
  const raw = url.searchParams.get("schema");
  if (raw === null) return DEFAULT_CLIENT_SCHEMA;

  const schema = parsePositiveInt(raw);
  if (schema === null) {
    throw new HttpError(400, "bad_request", "schema must be a positive integer.");
  }
  return schema;
}

// Takes the two columns of a LEFT JOINed schema_policies row; a schema with
// no policy row arrives as null and counts as current.
export function compatOf(policyState, sunsetAt) {
  if (!policyState || policyState === POLICY_CURRENT) return { state: COMPAT_OK };
  return { state: policyState, ...(sunsetAt ? { sunset_at: sunsetAt } : {}) };
}

export async function currentSchema(db, theme) {
  const row = await db
    .prepare("SELECT MAX(schema) AS schema FROM schema_policies WHERE theme = ? AND state = ?")
    .bind(theme, POLICY_CURRENT)
    .first();
  return row?.schema ?? DEFAULT_CLIENT_SCHEMA;
}
