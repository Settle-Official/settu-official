// Authorization and audit are one call. POST /admin/audit requires the service
// token, a valid session and is_admin on that account, so a 201 back IS the
// authorization -- and the attempt is on record before the action runs.

import { serviceFetch, serviceWrite } from "../api/server";

// Human-operated, so a cold backend costing 30s is fine here. That tolerance
// is exactly why admin was safe to move first.
const GUARD_TIMEOUT_MS = 45_000;

export interface AdminContext {
  auditId: string;
  actorId: string;
  actorEmail: string;
}

/** The caller's own session, which the audit log records as the actor. */
export function callerCredential(headers: Headers): string | null {
  // Strict prefix, like the Rust extractor's strip_prefix: Headers trims the
  // value, so a bare "Bearer " would otherwise yield the literal "Bearer".
  const auth = headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const bearer = auth.slice("Bearer ".length).trim();
    if (bearer) return bearer;
  }

  // Hand-parsed, and the name must match exactly: a prefix match would let
  // `x_settu_session` impersonate the real cookie.
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  for (const pair of cookie.split(";")) {
    const [name, value] = pair.split("=", 2);
    if (name?.trim() === "settu_session" && value?.trim()) return value.trim();
  }
  return null;
}

/**
 * Throws unless the caller is a signed-in admin. Fails closed on every path:
 * missing config, an unreachable API and a non-admin session all reject.
 */
export async function requireAdmin(
  request: Request,
  action: string,
  detail?: Record<string, unknown>,
): Promise<AdminContext> {
  const credential = callerCredential(request.headers);
  if (!credential) throw new Error("no caller credential");

  const recorded = await serviceFetch<{
    id: string;
    actor_id: string;
    actor_email: string;
  }>("/admin/audit", {
    method: "POST",
    body: { action, detail: detail ?? {} },
    credential,
    timeoutMs: GUARD_TIMEOUT_MS,
  });

  return {
    auditId: recorded.id,
    actorId: recorded.actor_id,
    actorEmail: recorded.actor_email,
  };
}

/**
 * Best-effort follow-up. A row with no outcome still records who attempted
 * what, which is the part that has to survive the action crashing.
 */
export function recordOutcome(
  auditId: string,
  outcome: string,
  // Must be a JSON object: the API merges it into the row's jsonb detail.
  detail?: object,
): void {
  void serviceWrite(
    `/admin/audit/${auditId}`,
    { outcome: outcome.slice(0, 500), ...(detail ? { detail } : {}) },
    GUARD_TIMEOUT_MS,
    "PATCH",
  );
}
