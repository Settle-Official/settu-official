/**
 * Handler for QStash drive callbacks (`POST /api/bridge/drive/[id]`). Pure
 * over injected deps so the route stays a thin wrapper and tests never touch
 * QStash or Redis.
 *
 * Fails closed: both signing keys must be set and the `upstash-signature`
 * must verify, else 401. The signed body names the id it was published for;
 * it must match the path, so a captured message can't be replayed at another
 * transfer.
 */

import { Receiver } from "@upstash/qstash";
import type { CctpStatus } from "../cctp/cctp-store";
import { advanceCctpTransfer } from "../cctp/advance";
import { DRIVE_DELAYS_S, driveUrl, scheduleDrive } from "./schedule";

export interface DriveDeps {
  signingKeys(): { current?: string; next?: string };
  verify(signature: string, rawBody: string, url?: string): Promise<boolean>;
  advance(id: string): Promise<CctpStatus>;
  schedule(id: string, attempt: number): Promise<void>;
}

export interface DriveInput {
  pathId: string;
  rawBody: string;
  signature: string | null;
}

export interface DriveResult {
  status: number;
  body: Record<string, unknown>;
}

export const defaultDriveDeps: DriveDeps = {
  signingKeys: () => ({
    current: process.env.QSTASH_CURRENT_SIGNING_KEY?.trim() || undefined,
    next: process.env.QSTASH_NEXT_SIGNING_KEY?.trim() || undefined,
  }),
  async verify(signature, rawBody, url) {
    const receiver = new Receiver({
      currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY!.trim(),
      nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY!.trim(),
      devMode: false, // never accept the public dev-server keys
    });
    return receiver.verify({ signature, body: rawBody, ...(url ? { url } : {}) });
  },
  advance: advanceCctpTransfer,
  schedule: (id, attempt) => scheduleDrive(id, attempt),
};

/** The URL QStash signed (we published to it), when APP_BASE_URL is known. */
export function expectedDriveUrl(id: string): string | undefined {
  const base = process.env.APP_BASE_URL?.trim();
  return base ? driveUrl(base, id) : undefined;
}

const UNAUTHORIZED: DriveResult = { status: 401, body: { error: "Unauthorized" } };

export async function handleDrive(
  input: DriveInput,
  deps: DriveDeps = defaultDriveDeps,
  url?: string,
): Promise<DriveResult> {
  const keys = deps.signingKeys();
  if (!keys.current || !keys.next || !input.signature) return UNAUTHORIZED;
  let ok = false;
  try {
    ok = await deps.verify(input.signature, input.rawBody, url);
  } catch {
    ok = false; // SignatureError and friends
  }
  if (!ok) return UNAUTHORIZED;

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    parsed = null;
  }
  const p = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const attempt = p?.attempt;
  if (
    !p ||
    p.id !== input.pathId ||
    typeof attempt !== "number" ||
    !Number.isInteger(attempt) ||
    attempt < 0 ||
    attempt >= DRIVE_DELAYS_S.length
  ) {
    return { status: 400, body: { error: "Invalid drive request." } };
  }

  const id = input.pathId;
  let status: CctpStatus | null = null;
  try {
    status = await deps.advance(id);
  } catch (e) {
    console.error("[bridge/drive] advance failed:", id, e instanceof Error ? e.message : "unknown");
  }
  if (status === "completed" || status === "failed") {
    return { status: 200, body: { id, status, rescheduled: false } };
  }
  try {
    await deps.schedule(id, attempt + 1);
  } catch (e) {
    // The sweep is the backstop; a 5xx would only make QStash redeliver this.
    console.error("[bridge/drive] reschedule failed:", id, e instanceof Error ? e.message : "unknown");
  }
  return { status: 200, body: { id, status, rescheduled: attempt + 1 < DRIVE_DELAYS_S.length } };
}
