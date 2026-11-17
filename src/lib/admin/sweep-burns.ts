/**
 * Body of POST /api/admin/offramp/sweep-burns, over injected deps so it can
 * be tested without Redis or chains.
 *
 * The offramp burn sweep runs first and owns the response status and body,
 * exactly as before. The bridge event sweep (Task 15) then runs in its own
 * try/catch and only ever ADDS a `bridgeSweep` key: its failure can't change
 * the offramp result or status code. It runs even when the offramp sweep
 * failed, so bridges keep being driven if the offramp side is unhealthy.
 *
 * Time bound: the route has maxDuration 60 s. The bridge sweep gets whatever
 * is left of TOTAL_BUDGET_MS (50 s) after the offramp sweep, and the response
 * doesn't wait past that — so a slow bridge sweep can't turn the offramp's
 * 200 into a function timeout. (Abandoned bridge work is safe: cursors only
 * move after a chunk is fully processed.)
 */

export const TOTAL_BUDGET_MS = 50_000;
const MIN_BRIDGE_BUDGET_MS = 2_000;

export interface SweepBurnsDeps<T extends object> {
  offrampSweep(): Promise<T>;
  bridgeSweep(): Promise<{ created: number; advanced: number }>;
  log(msg: string): void;
  now?(): number;
  budgetMs?: number;
}

export type BridgeSweepOutcome = { created: number; advanced: number } | { error: string };

export async function runSweepBurns<T extends object>(
  deps: SweepBurnsDeps<T>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const now = deps.now ?? Date.now;
  const start = now();
  let status = 200;
  let body: Record<string, unknown>;
  try {
    body = { ...(await deps.offrampSweep()) } as Record<string, unknown>;
  } catch (err: any) {
    status = 500;
    body = { error: err?.message || "burn sweep failed" };
  }

  let bridgeSweep: BridgeSweepOutcome;
  const remaining = (deps.budgetMs ?? TOTAL_BUDGET_MS) - (now() - start);
  try {
    if (remaining < MIN_BRIDGE_BUDGET_MS) throw new Error("skipped: no time left this run");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), remaining);
    });
    try {
      bridgeSweep = await Promise.race([deps.bridgeSweep(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "bridge sweep failed";
    deps.log(`[sweep-burns] bridge sweep failed: ${message}`);
    bridgeSweep = { error: message };
  }
  return { status, body: { ...body, bridgeSweep } };
}
