/**
 * Server-side backstop for a CCTP offramp burn whose client-side registration
 * never landed.
 *
 * The normal path registers the burn (`/api/offramp/bridge/register-transfer`)
 * right after it's broadcast, so the attest→mint pipeline can carry it to
 * Base. If that call is lost — the tab closed during the ~15s submit, the
 * network dropped, the browser was killed — the burn is stranded: the mint
 * recipient is fixed at burn time and can never be redirected or re-burned, so
 * nothing else will ever mint it. This happened for real (a slow Soroban RPC
 * timed the confirmation poll out, the flow threw before registering, ~10 USDC
 * burned with nothing to mint it).
 *
 * This sweep closes that gap: for each recent non-terminal order it scans the
 * sender's on-chain history for a matching `deposit_for_burn`, verifies it via
 * Circle Iris, and registers it through the same idempotent path the client
 * uses. Wired into the daily cron and an admin route.
 *
 * Scope: Stellar only. The EVM and Solana offramp flows register synchronously
 * the instant they have a burn hash (no confirmation gate in between), so
 * their strand window is a couple of seconds guarded by retry + sendBeacon —
 * far smaller than Stellar's was. Extend here if that proves insufficient.
 */

import {
  listOrderMetaIds,
  getOrderMeta,
  type OrderMeta,
} from "./order-meta-store";
import { getPayoutStatus, isTerminal } from "./payout-store";
import { getCctpTransfer } from "../cctp/cctp-store";
import { fetchBurnMessage } from "../cctp/iris-client";
import { registerOfframpBurn } from "../cctp/register-burn";
import { advanceCctpTransfer } from "../cctp/advance";
import { CCTP_DOMAIN } from "../cctp/constants";

const STELLAR_HORIZON =
  process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org";

// Don't touch an order younger than this — the client is very likely still
// finishing the flow, and racing it risks a duplicate ledger entry (the
// register itself is idempotent, but the client also does its own).
const GRACE_MS = 8 * 60_000;
// Ignore orders older than this — OrderMeta lives 48h, but a burn this old
// that still isn't registered is a manual-triage case, not an auto-recover.
const MAX_AGE_MS = 24 * 60 * 60_000;
// How many of the sender's recent operations to inspect.
const MAX_OPS_SCANNED = 30;

/** Lowercased low-20-bytes (40 hex chars) of an address, no 0x. */
function low20(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").slice(-40);
}

/**
 * Look for a `deposit_for_burn` from `senderAddress` whose CCTP mint recipient
 * is `receiveAddress`. Returns the burn tx hash + atomic amount, or null.
 */
async function findStellarBurn(
  senderAddress: string,
  receiveAddress: string,
): Promise<{ burnTxHash: string; amountAtomic: string } | null> {
  const url =
    `${STELLAR_HORIZON}/accounts/${senderAddress}/operations` +
    `?order=desc&limit=${MAX_OPS_SCANNED}&include_failed=false`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const body = await res.json();
  const ops: any[] = body?._embedded?.records ?? [];
  const target = low20(receiveAddress);
  const checked = new Set<string>();

  for (const op of ops) {
    if (op?.type !== "invoke_host_function") continue;
    const txHash: string = op.transaction_hash;
    if (!txHash || checked.has(txHash)) continue;
    checked.add(txHash);

    let msg;
    try {
      msg = await fetchBurnMessage({
        sourceDomain: CCTP_DOMAIN.stellar,
        transactionHash: txHash,
      });
    } catch {
      continue; // Iris hiccup — try the next candidate
    }
    if (!msg?.mintRecipient) continue; // not a CCTP burn
    if (low20(msg.mintRecipient) === target) {
      return { burnTxHash: txHash, amountAtomic: msg.amount ?? "0" };
    }
  }
  return null;
}

function orderRecoverable(meta: OrderMeta | null): meta is OrderMeta {
  if (!meta?.senderAddress || !meta.receiveAddress) return false;
  if ((meta.sourceChain || "stellar") !== "stellar") return false;
  const age = Date.now() - meta.createdAt;
  return age >= GRACE_MS && age <= MAX_AGE_MS;
}

export interface BurnBackstopResult {
  scanned: number;
  recovered: string[];
  errors: number;
}

export async function reconcileUnregisteredBurns(): Promise<BurnBackstopResult> {
  const orderIds = await listOrderMetaIds();
  const recovered: string[] = [];
  let errors = 0;

  for (const orderId of orderIds) {
    try {
      const meta = await getOrderMeta(orderId);
      if (!orderRecoverable(meta)) continue;

      // Already settled/expired/refunded — nothing to recover.
      const payout = await getPayoutStatus(orderId);
      if (payout && isTerminal(payout.status)) continue;

      const found = await findStellarBurn(
        meta.senderAddress!,
        meta.receiveAddress!,
      );
      if (!found) continue;

      // Already registered (record id == burn tx hash)? Then the pipeline
      // already has it — just give it a nudge and move on.
      if (await getCctpTransfer(found.burnTxHash)) {
        await advanceCctpTransfer(found.burnTxHash).catch(() => {});
        continue;
      }

      await registerOfframpBurn({
        burnTxHash: found.burnTxHash,
        mintRecipient: meta.receiveAddress!,
        amount:
          meta.amountUsdc != null
            ? String(meta.amountUsdc)
            : (Number(found.amountAtomic) / 1e6).toString(),
        paycrestOrderId: orderId,
        sourceChain: "stellar",
        connectedAddress: meta.senderAddress!,
      });
      await advanceCctpTransfer(found.burnTxHash).catch(() => {});

      recovered.push(orderId);
      console.log(
        `[burn-backstop] recovered ${orderId}: registered orphaned burn ${found.burnTxHash}`,
      );
    } catch (err) {
      errors++;
      console.error(`[burn-backstop] ${orderId} failed:`, err);
    }
  }

  return { scanned: orderIds.length, recovered, errors };
}
