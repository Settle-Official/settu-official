/**
 * What the dashboard did, and to which order.
 *
 * These actions move real money, so they leave a trail. The operator name is
 * self-reported — a shared password can't prove who was typing — but it is
 * far better than nothing when two people have the password and one of them
 * registered the wrong burn.
 */

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const KEY = "admin:audit";
const MAX_ENTRIES = 1000;

export interface AuditEntry {
  readonly at: number;
  readonly action: string;
  readonly orderId: string;
  /** Self-reported; a shared password cannot attribute this reliably. */
  readonly operator: string;
  readonly outcome: string;
  readonly detail?: string;
}

export async function recordAdminAction(entry: Omit<AuditEntry, "at">): Promise<void> {
  const full: AuditEntry = { ...entry, at: Date.now() };
  // Never let a logging failure break a recovery that already happened.
  try {
    await redis.lpush(KEY, JSON.stringify(full));
    await redis.ltrim(KEY, 0, MAX_ENTRIES - 1);
  } catch (err) {
    console.error("[admin-audit] failed to record", full, err);
  }
}

export async function listAdminActions(limit = 50): Promise<AuditEntry[]> {
  const raw = await redis.lrange<string | AuditEntry>(KEY, 0, limit - 1);
  return (raw ?? [])
    .map((r) => (typeof r === "string" ? safeParse(r) : r))
    .filter((e): e is AuditEntry => e !== null);
}

function safeParse(raw: string): AuditEntry | null {
  try {
    return JSON.parse(raw) as AuditEntry;
  } catch {
    return null;
  }
}
