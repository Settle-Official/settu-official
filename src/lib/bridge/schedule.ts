/**
 * Server-side driving for user bridges: after registration, QStash calls
 * `/api/bridge/drive/[id]` on a short delay ladder so a bridge completes even
 * if the user's tab is closed. Past the last rung the 5-minute event sweep
 * (`sweepBridgedEvents`) takes over. Nothing here holds a connection open.
 *
 * Env: QSTASH_TOKEN (publish), APP_BASE_URL (callback origin). Either unset ->
 * log once and no-op, so local/dev never crashes; the sweep still drives.
 */

import { Client } from "@upstash/qstash";

/** Delay (seconds) before drive attempt n. Attempt >= length publishes nothing. */
export const DRIVE_DELAYS_S = [15, 30, 60, 120, 300] as const;

export interface PublishRequest {
  url: string;
  body: { id: string; attempt: number };
  delay: number;
  deduplicationId: string;
}

export interface ScheduleDeps {
  token(): string | undefined;
  baseUrl(): string | undefined;
  publish(req: PublishRequest): Promise<void>;
  log(msg: string): void;
}

export function driveUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/bridge/drive/${encodeURIComponent(id)}`;
}

export const defaultScheduleDeps: ScheduleDeps = {
  token: () => process.env.QSTASH_TOKEN?.trim() || undefined,
  baseUrl: () => process.env.APP_BASE_URL?.trim() || undefined,
  async publish(req) {
    // devMode false: never swap in the public dev-server keys via QSTASH_DEV.
    const client = new Client({ token: process.env.QSTASH_TOKEN!.trim(), devMode: false });
    await client.publishJSON({
      url: req.url,
      body: req.body,
      delay: req.delay,
      deduplicationId: req.deduplicationId,
    });
  },
  log: (m) => console.warn(m),
};

const warned = new WeakSet<ScheduleDeps>();

/**
 * Schedule drive attempt `attempt` for bridge `id`. The deduplication id is
 * per (id, attempt), so repeated registrations of the same tx don't fork
 * extra drive chains (QStash keeps dedup ids for 90 days).
 */
export async function scheduleDrive(
  id: string,
  attempt: number = 0,
  deps: ScheduleDeps = defaultScheduleDeps,
): Promise<void> {
  const delay = DRIVE_DELAYS_S[attempt];
  if (delay === undefined) return; // ladder done; the 5-minute sweep takes over
  const token = deps.token();
  const base = deps.baseUrl();
  if (!token || !base) {
    if (!warned.has(deps)) {
      warned.add(deps);
      deps.log(
        `[bridge/schedule] ${!token ? "QSTASH_TOKEN" : "APP_BASE_URL"} is not set; server-side drive disabled (the event sweep still drives bridges)`,
      );
    }
    return;
  }
  await deps.publish({
    url: driveUrl(base, id),
    body: { id, attempt },
    delay,
    deduplicationId: `bridge-drive-${id}-${attempt}`,
  });
}
