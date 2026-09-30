import { after, NextRequest, NextResponse } from "next/server";
import { getPayoutStatus, isTerminal } from "@/lib/offramp/payout-store";
import { reconcilePayoutOrder } from "@/lib/offramp/settlement";
import { recoverOrder } from "@/lib/offramp/burn-backstop";
import { claimPollRecovery } from "@/lib/offramp/poll-recovery";
import { getBurnForOrder } from "@/lib/offramp/burn-by-order";
import { findBurnForWaitingOrder } from "@/lib/offramp/waiting-burn";

// How long a waiting page's request may spend on the chain lookup before it
// answers "not yet" (the lookup itself carries on; see findBurnForWaitingOrder).
const WAITING_BURN_TIMEOUT_MS = 20_000;

/**
 * `?awaitingBurn=1`: the page has asked the wallet to send the burn and not
 * heard back. Look for the burn now (no grace period: the page knows it is
 * waiting) and return its hash as `burnTxHash`, so the page can carry on even
 * if the wallet's reply was lost. Safe to expose: recovery only registers a
 * burn it finds on chain from this order's sender, to this order's own
 * receive address, for its exact amount, and registration is idempotent.
 */
async function burnForWaitingPage(orderId: string): Promise<string | null> {
  return findBurnForWaitingOrder(orderId, {
    getBurnForOrder,
    claim: claimPollRecovery,
    recover: (id) => recoverOrder(id, { ignoreGrace: true }),
    keepAlive: (work) => after(work),
    timeoutMs: WAITING_BURN_TIMEOUT_MS,
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const { orderId } = await params;
    const awaitingBurn = request.nextUrl.searchParams.get("awaitingBurn") === "1";

    // Independent of Paycrest, so an outage there can't hide a found burn.
    const burnTxHash = awaitingBurn ? await burnForWaitingPage(orderId) : null;
    const withBurn = burnTxHash ? { burnTxHash } : {};

    const cached = await getPayoutStatus(orderId);

    // A terminal cached status is authoritative — no Paycrest call needed.
    if (cached && isTerminal(cached.status)) {
      return NextResponse.json({
        data: { id: orderId, status: cached.status, ...withBurn },
        source: "cache",
      });
    }

    // Non-terminal or missing: reconcile against Paycrest's LIVE status.
    // Paycrest surfaces `fulfilled` (bank credited) only through the API — it
    // sends no webhook for it — so a webhook-only view stalls a completed
    // offramp forever. This self-heals: the live status is written back to the
    // payout store (so the SSE stream + next poll see it) and the settlement
    // is recorded once it's confirmed.
    try {
      const status = await reconcilePayoutOrder(orderId);

      // The user is sitting on this page watching a transfer that hasn't
      // finished. If their burn landed on-chain but its registration was
      // lost, nothing will ever mint it — and waiting for the sweep to
      // notice is not an acceptable answer for someone's money. Their own
      // poll is the earliest moment we can know, so recover here.
      //
      // Rate-limited per order (see claimPollRecovery): the on-chain lookup
      // costs a Horizon/RPC call plus Iris, and a poll runs every few
      // seconds. Run after the response so a slow chain never delays it —
      // with after(), not a bare promise, which Vercel may stop once the
      // response is sent.
      if (!awaitingBurn && !isTerminal(status) && (await claimPollRecovery(orderId))) {
        after(() =>
          recoverOrder(orderId).catch((err) =>
            console.error(`[poll-recovery] ${orderId} failed:`, err),
          ),
        );
      }

      return NextResponse.json({
        data: { id: orderId, status, ...withBurn },
        source: "api",
      });
    } catch (apiErr: any) {
      // Paycrest unreachable — serve the cache rather than erroring the poller.
      if (cached || burnTxHash) {
        return NextResponse.json({
          data: { id: orderId, status: cached?.status ?? "pending", ...withBurn },
          source: "cache-fallback",
        });
      }
      throw apiErr;
    }
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to fetch Paycrest order status" },
      { status: 500 },
    );
  }
}
