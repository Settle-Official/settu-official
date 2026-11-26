import { SHEET_HEADERS } from "./schema";

/**
 * Appends waitlist rows to a Google Sheet through a small Apps Script web app
 * bound to that sheet (source: docs/waitlist-apps-script.gs). No Cloud project
 * or key file: the script runs as the sheet's owner, and only accepts requests
 * that carry the shared secret.
 *
 * Env:
 *   WAITLIST_SHEET_WEBHOOK_URL — the web app's /exec URL
 *   WAITLIST_SHEET_SECRET      — must match the script's SECRET property
 */

export function sheetsConfigured(): boolean {
  return Boolean(process.env.WAITLIST_SHEET_WEBHOOK_URL && process.env.WAITLIST_SHEET_SECRET);
}

export async function appendWaitlistRow(row: string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  // Apps Script answers a POST with a redirect to the result; follow it.
  const res = await fetchImpl(process.env.WAITLIST_SHEET_WEBHOOK_URL!, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ secret: process.env.WAITLIST_SHEET_SECRET, headers: SHEET_HEADERS, row }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let data: { ok?: boolean; error?: string } = {};
  try { data = JSON.parse(text); } catch { /* an HTML error page from Google */ }
  if (!res.ok || data.ok !== true) {
    throw new Error(`Sheet webhook failed (${res.status})${data.error ? `: ${data.error}` : ""}`);
  }
}
