/**
 * Finds the burn for an order whose page is still waiting on the wallet.
 *
 * On Solana and the EVM chains the wallet broadcasts the burn itself, then
 * reports the signature back over WalletConnect. On a phone that reply is
 * lost if the relay socket was suspended while the user was in their wallet
 * app: the burn is on chain, but the page never hears about it, so it never
 * registers the burn and nothing mints it (a stranded burn, seen live on
 * 2026-09-28). The page therefore asks here as well, and carries on with the
 * flow as soon as either source has the burn.
 *
 * Dependencies are injected so this stays free of Redis and Next imports:
 * the status route wires in the real ones.
 */

import type { OrderRecoveryResult } from "./burn-backstop";

export interface WaitingBurnDeps {
  /** The burn a previous registration recorded for this order, if any. */
  readonly getBurnForOrder: (orderId: string) => Promise<string | null>;
  /** Rate limit: true when this call may spend a chain lookup. */
  readonly claim: (orderId: string) => Promise<boolean>;
  /** Looks for the burn on chain and registers it if it isn't yet. */
  readonly recover: (orderId: string) => Promise<OrderRecoveryResult>;
  /** Keeps a recovery that outlived the timeout running after the response. */
  readonly keepAlive: (work: Promise<unknown>) => void;
  /** How long the page's request may wait on the chain. */
  readonly timeoutMs: number;
}

export async function findBurnForWaitingOrder(
  orderId: string,
  deps: WaitingBurnDeps,
): Promise<string | null> {
  // Cheap: whoever registered it (the page, the sweep, the admin console or
  // an earlier poll) left a pointer. Checked on every poll, unlike the chain.
  const known = await deps.getBurnForOrder(orderId).catch(() => null);
  if (known) return known;

  if (!(await deps.claim(orderId))) return null;

  const recovery = deps.recover(orderId).catch((err) => {
    console.error(`[waiting-burn] ${orderId} failed:`, err);
    return null;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deps.timeoutMs);
  });

  const winner = await Promise.race([recovery, timedOut]);
  clearTimeout(timer);

  if (winner === "timeout") {
    // A slow chain mustn't hold the page's poll open, but the lookup (and
    // the registration it may make) has to finish, or this poll found the
    // burn for nobody. The next poll reads the pointer it leaves.
    deps.keepAlive(recovery);
    return null;
  }
  return winner?.burnTxHash ?? null;
}
