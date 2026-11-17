/**
 * GET /api/admin/bridge/explorer handler: pure over injected deps (like
 * bridge-admin.ts) so the 401 guard and param validation test without Redis.
 *
 *   ?cursor&limit&status&source&dest&speed&from&to&q  → { rows, nextCursor? }
 *   ?totals=24h|7d                                    → { totals }
 */

import type { NextRequest } from "next/server";
import { isAuthorisedAdmin } from "../admin/auth";
import { BRIDGE_CHAINS } from "./chains";
import {
  bridgeTotals,
  listBridges,
  MAX_LIMIT,
  type ExplorerFilters,
  type ExplorerRow,
  type ExplorerTotals,
  type TotalsWindow,
} from "./explorer";

export interface ExplorerResult {
  status: number;
  body: unknown;
}

export interface ExplorerHandlerDeps {
  isAdmin(request: NextRequest): boolean;
  list(f: ExplorerFilters): Promise<{ rows: ExplorerRow[]; nextCursor?: string }>;
  totals(w: TotalsWindow): Promise<ExplorerTotals>;
}

const STATUSES = ["submitted", "verifying", "delivering", "completed", "failed", "stuck"];
const fail = (status: number, code: string, error: string): ExplorerResult => ({
  status,
  body: { error, code },
});

function intParam(v: string | null): number | null | undefined {
  if (v === null || v === "") return undefined;
  return /^\d{1,15}$/.test(v) ? Number(v) : null;
}

export async function explorerGet(
  request: NextRequest,
  overrides: Partial<ExplorerHandlerDeps> = {},
): Promise<ExplorerResult> {
  const d: ExplorerHandlerDeps = {
    isAdmin: isAuthorisedAdmin,
    list: listBridges,
    totals: bridgeTotals,
    ...overrides,
  };
  if (!d.isAdmin(request)) return fail(401, "unauthorized", "Unauthorized");

  const p = new URL(request.url).searchParams;
  try {
    const totals = p.get("totals");
    if (totals !== null) {
      if (totals !== "24h" && totals !== "7d") return fail(400, "invalid_request", "totals must be 24h or 7d.");
      return { status: 200, body: { totals: await d.totals(totals) } };
    }

    const limit = intParam(p.get("limit"));
    const from = intParam(p.get("from"));
    const to = intParam(p.get("to"));
    const cursor = p.get("cursor");
    if (limit === null || limit === 0 || (limit !== undefined && limit > MAX_LIMIT)) {
      return fail(400, "invalid_request", `limit must be 1-${MAX_LIMIT}.`);
    }
    if (from === null || to === null) return fail(400, "invalid_request", "from/to must be epoch milliseconds.");
    if (cursor && !/^\d{1,15}$/.test(cursor)) return fail(400, "invalid_request", "Invalid cursor.");

    const status = p.get("status") || undefined;
    if (status && !STATUSES.includes(status)) return fail(400, "invalid_request", "Unknown status.");
    const source = p.get("source") || undefined;
    const dest = p.get("dest") || undefined;
    if ((source && !(source in BRIDGE_CHAINS)) || (dest && !(dest in BRIDGE_CHAINS))) {
      return fail(400, "invalid_request", "Unknown chain.");
    }
    const speed = p.get("speed") || undefined;
    if (speed && speed !== "fast" && speed !== "standard") return fail(400, "invalid_request", "Unknown speed.");
    const q = p.get("q")?.trim().slice(0, 128) || undefined;

    const f: ExplorerFilters = {
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(status ? { status } : {}),
      ...(source ? { source } : {}),
      ...(dest ? { dest } : {}),
      ...(speed ? { speed: speed as "fast" | "standard" } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(q ? { q } : {}),
    };
    return { status: 200, body: await d.list(f) };
  } catch (e) {
    console.error("[admin/bridge/explorer] failed:", e instanceof Error ? `${e.name}: ${e.message}` : "unknown");
    return fail(503, "unavailable", "Couldn't load bridges right now — try again in a moment.");
  }
}
