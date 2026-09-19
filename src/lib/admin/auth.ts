/**
 * Admin auth for the recovery dashboard.
 *
 * A shared password, exchanged once for a short-lived signed cookie. The
 * existing `Authorization: Bearer $ADMIN_API_SECRET` still works on every
 * admin route so curl and the cron are unaffected — this only adds a second
 * way in, for a human in a browser.
 *
 * Known limitation, accepted deliberately: one shared password means the
 * audit log can record WHAT happened but not WHO did it. The confirm step
 * asks for an operator name to partially cover that, but it is self-reported.
 * Moving to per-person auth later only changes `isAuthorisedAdmin` — nothing
 * downstream of it needs to know.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";

const COOKIE_NAME = "settu_admin";
// Short on purpose: this cookie authorises actions that move real money, so
// a borrowed laptop stops being a problem within the working day.
const SESSION_MS = 8 * 60 * 60_000;

function signingKey(): string | null {
  // Reuses the existing admin secret as the signing key rather than adding
  // another one to rotate. The password is what a human types; this is what
  // proves the cookie came from us.
  return process.env.ADMIN_API_SECRET || null;
}

function sign(expiresAt: number, key: string): string {
  return createHmac("sha256", key).update(String(expiresAt)).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch; treat that as "not equal".
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** Checks the typed password. Returns a cookie value on success. */
export function passwordToCookie(password: string): string | null {
  const expected = process.env.ADMIN_DASHBOARD_PASSWORD;
  const key = signingKey();
  if (!expected || !key) return null;
  if (!safeEqual(password, expected)) return null;

  const expiresAt = Date.now() + SESSION_MS;
  return `${expiresAt}.${sign(expiresAt, key)}`;
}

function cookieValid(value: string | undefined): boolean {
  const key = signingKey();
  if (!value || !key) return false;
  const [rawExpiry, signature] = value.split(".");
  const expiresAt = Number(rawExpiry);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  if (!signature) return false;
  return safeEqual(signature, sign(expiresAt, key));
}

/**
 * True when the request may act as an admin — by signed cookie (the
 * dashboard) or bearer token (curl, cron).
 *
 * When ADMIN_API_SECRET is unset, as in local dev, this stays open exactly
 * like the existing admin routes already do. Production must set it.
 */
export function isAuthorisedAdmin(request: NextRequest): boolean {
  const secret = process.env.ADMIN_API_SECRET;
  if (!secret) return true;
  if (request.headers.get("authorization") === `Bearer ${secret}`) return true;
  return cookieValid(request.cookies.get(COOKIE_NAME)?.value);
}

export const ADMIN_COOKIE = COOKIE_NAME;
export const ADMIN_SESSION_MS = SESSION_MS;
