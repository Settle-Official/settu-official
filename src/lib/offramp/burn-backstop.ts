// Recovers a CCTP offramp burn whose client-side registration never landed —
// the mint recipient is fixed at burn time, so nothing else will ever mint it.
// Covers every burning chain (Stellar, Solana, EVM); Base transfers directly.

import {
  listOrderMetaIds,
  getOrderMeta,
  type OrderMeta,
} from "./order-meta-store";
import { getPayoutStatus } from "./payout-store";
import type { PayoutStatus } from "./types";
import { getCctpTransfer } from "../cctp/cctp-store";
import { fetchBurnMessage } from "../cctp/iris-client";
import { withRetry } from "../cctp/retry";
import { registerOfframpBurn } from "../cctp/register-burn";
import { advanceCctpTransfer } from "../cctp/advance";
import { CCTP_DOMAIN } from "../cctp/constants";
import {
  EVM_SOURCE_CHAINS,
  EVM_CCTP_TOKEN_MESSENGER_V2,
  isCctpBridgeChain,
  type EvmChainKey,
} from "../cctp/evm-chains";
import { SOLANA_CCTP_DOMAIN } from "../solana/config";
import type { OfframpSourceChain } from "./transaction-history";

const STELLAR_HORIZON =
  process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org";

// Younger than this and the client is probably still finishing the flow.
const GRACE_MS = 8 * 60_000;
// Older than this is manual triage, not auto-recovery.
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_OPS_SCANNED = 30;
// Base's public RPC rejects anything wider than 2,000 blocks per eth_getLogs.
const EVM_LOG_SPAN = 2_000;
// Bounds lookback per order so one slow chain can't stall the sweep.
const EVM_MAX_CHUNKS = 24;
// CCTP v2 DepositForBurn, verified against live TokenMessengerV2 logs on Base.
const DEPOSIT_FOR_BURN_TOPIC =
  "0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5";

export interface FoundBurn {
  burnTxHash: string;
  amountAtomic: string;
}

/** Lowercased low-20-bytes (40 hex chars) of an address, no 0x. */
function low20(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").slice(-40);
}

/** Data word 0 is the amount, word 1 the bytes32 mint recipient. */
export function decodeDepositForBurnData(
  data: string,
): { mintRecipient: string; amountAtomic: string } | null {
  const words = data.replace(/^0x/, "");
  if (words.length < 128) return null;
  return {
    amountAtomic: BigInt(`0x${words.slice(0, 64)}`).toString(),
    mintRecipient: `0x${low20(words.slice(64, 128))}`,
  };
}

// Amount the order expects burned — recipient alone is only unique because
// Paycrest issues a fresh deposit address per order, too thin for attribution.
function expectedAtomic(meta: OrderMeta): string | null {
  if (meta.amountUsdc == null) return null;
  return BigInt(Math.round(meta.amountUsdc * 1e6)).toString();
}

/** True when a candidate burn matches the order's recipient and amount. */
function burnMatches(
  mintRecipient: string,
  amountAtomic: string,
  target: string,
  expected: string | null,
): boolean {
  if (low20(mintRecipient) !== target) return false;
  return expected === null || amountAtomic === expected;
}

/** Scans the sender's Horizon history for a burn matching this order. */
async function findStellarBurn(
  senderAddress: string,
  receiveAddress: string,
  expected: string | null,
): Promise<FoundBurn | null> {
  const url =
    `${STELLAR_HORIZON}/accounts/${senderAddress}/operations` +
    `?order=desc&limit=${MAX_OPS_SCANNED}&include_failed=false`;
  // Retried, and an HTTP error throws rather than returning null. Public
  // Horizon regularly takes 5-18s under load, and treating a timeout or a
  // 429 as "this wallet has no burn" is how a stranded burn gets reported
  // as safe. Not finding a burn must mean we looked.
  const body = await withRetry(
    async () => {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        throw new Error(`Horizon ${res.status} while scanning ${senderAddress}`);
      }
      return res.json();
    },
    { attempts: 3, delayMs: 1000 },
  );
  const ops: any[] = body?._embedded?.records ?? [];
  const target = low20(receiveAddress);
  const checked = new Set<string>();
  let lookupFailed = false;

  for (const op of ops) {
    if (op?.type !== "invoke_host_function") continue;
    const txHash: string = op.transaction_hash;
    if (!txHash || checked.has(txHash)) continue;
    checked.add(txHash);

    let msg;
    try {
      msg = await withRetry(() =>
        fetchBurnMessage({
          sourceDomain: CCTP_DOMAIN.stellar,
          transactionHash: txHash,
        }),
      );
    } catch {
      // Remember that we could not actually check this candidate. Skipping
      // quietly is how a transient Iris error turns into "no burn found",
      // which for a stranded burn is the most dangerous possible answer —
      // it says the user's money is fine when it isn't.
      lookupFailed = true;
      continue;
    }
    if (!msg?.mintRecipient) continue; // not a CCTP burn
    const amountAtomic = msg.amount ?? "0";
    if (burnMatches(msg.mintRecipient, amountAtomic, target, expected)) {
      return { burnTxHash: txHash, amountAtomic };
    }
  }
  if (lookupFailed) {
    throw new Error(
      "Could not check every candidate transaction (Iris unreachable) — " +
        "cannot conclude there is no burn.",
    );
  }
  return null;
}

/** Same on Solana, over the signer's recent signatures. */
async function findSolanaBurn(
  senderAddress: string,
  receiveAddress: string,
  expected: string | null,
): Promise<FoundBurn | null> {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) return null;

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [senderAddress, { limit: MAX_OPS_SCANNED }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Solana RPC ${res.status} while scanning ${senderAddress}`);
  }
  const signatures: any[] = (await res.json())?.result ?? [];
  const target = low20(receiveAddress);
  let lookupFailed = false;

  for (const entry of signatures) {
    if (entry?.err || !entry?.signature) continue;

    let msg;
    try {
      msg = await withRetry(() =>
        fetchBurnMessage({
          sourceDomain: SOLANA_CCTP_DOMAIN,
          transactionHash: entry.signature,
        }),
      );
    } catch {
      lookupFailed = true;
      continue;
    }
    if (!msg?.mintRecipient) continue; // not a CCTP burn
    const amountAtomic = msg.amount ?? "0";
    if (burnMatches(msg.mintRecipient, amountAtomic, target, expected)) {
      return { burnTxHash: entry.signature, amountAtomic };
    }
  }
  if (lookupFailed) {
    throw new Error(
      "Could not check every candidate transaction (Iris unreachable) — " +
        "cannot conclude there is no burn.",
    );
  }
  return null;
}

/** JSON-RPC call returning null rather than throwing. */
async function evmRpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body?.error ? null : body?.result;
}

// EVM has no list-transactions-by-address RPC, so read DepositForBurn logs
// filtered on the indexed depositor topic, walking back in bounded spans
// because providers cap the block range of a single eth_getLogs.
async function findEvmBurn(
  chainKey: EvmChainKey,
  senderAddress: string,
  receiveAddress: string,
  orderCreatedAt: number,
  expected: string | null,
): Promise<FoundBurn | null> {
  const chain = EVM_SOURCE_CHAINS[chainKey];
  if (!chain || !isCctpBridgeChain(chain)) return null;
  const rpcUrl = process.env[chain.rpcUrlEnvVar];
  if (!rpcUrl) return null;

  const head = await evmRpc(rpcUrl, "eth_blockNumber", []);
  if (!head) return null;
  const target = low20(receiveAddress);
  // Indexed address topics are the 20-byte address left-padded to 32 bytes.
  const depositorTopic = `0x${"0".repeat(24)}${low20(senderAddress)}`;
  const sinceSeconds = Math.floor(orderCreatedAt / 1000);

  let toBlock = Number(BigInt(head));
  for (let chunk = 0; chunk < EVM_MAX_CHUNKS && toBlock > 0; chunk++) {
    const fromBlock = Math.max(0, toBlock - EVM_LOG_SPAN);

    const logs = await evmRpc(rpcUrl, "eth_getLogs", [
      {
        address: EVM_CCTP_TOKEN_MESSENGER_V2,
        topics: [DEPOSIT_FOR_BURN_TOPIC, null, depositorTopic],
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
      },
    ]);

    // Newest first, so the most recent candidate in a span wins.
    for (const log of (logs ?? []).slice().reverse()) {
      const decoded = decodeDepositForBurnData(log?.data ?? "");
      if (!decoded) continue;
      if (
        !burnMatches(decoded.mintRecipient, decoded.amountAtomic, target, expected)
      ) {
        continue;
      }
      return {
        burnTxHash: log.transactionHash,
        amountAtomic: decoded.amountAtomic,
      };
    }

    // Nothing older than the order itself can belong to it.
    const block = await evmRpc(rpcUrl, "eth_getBlockByNumber", [
      `0x${fromBlock.toString(16)}`,
      false,
    ]);
    if (block?.timestamp && Number(BigInt(block.timestamp)) < sinceSeconds) break;
    toBlock = fromBlock - 1;
  }
  return null;
}

/** Routes an order to the scanner for whichever chain it burned on. */
export async function findBurn(meta: OrderMeta): Promise<FoundBurn | null> {
  const chain = (meta.sourceChain || "stellar") as OfframpSourceChain;
  const expected = expectedAtomic(meta);
  if (chain === "stellar") {
    return findStellarBurn(meta.senderAddress!, meta.receiveAddress!, expected);
  }
  if (chain === "solana") {
    return findSolanaBurn(meta.senderAddress!, meta.receiveAddress!, expected);
  }
  return findEvmBurn(
    chain as EvmChainKey,
    meta.senderAddress!,
    meta.receiveAddress!,
    meta.createdAt,
    expected,
  );
}

export function orderRecoverable(meta: OrderMeta | null): meta is OrderMeta {
  if (!meta?.senderAddress || !meta.receiveAddress) return false;
  // Base transfers directly instead of burning, so it has nothing to recover.
  const chain = (meta.sourceChain || "stellar") as OfframpSourceChain;
  if (chain !== "stellar" && chain !== "solana") {
    const evmChain = EVM_SOURCE_CHAINS[chain as EvmChainKey];
    if (!evmChain || !isCctpBridgeChain(evmChain)) return false;
  }
  const age = Date.now() - meta.createdAt;
  return age >= GRACE_MS && age <= MAX_AGE_MS;
}

/**
 * Genuinely nothing left to do — the payout already completed or was
 * refunded. Deliberately excludes "expired": that's the status Paycrest
 * gives an order it never saw a deposit for, which is exactly what a
 * stranded (unregistered) burn looks like from their side. Confirmed live:
 * a burn stranded, its order expired ~1h later, and the old isTerminal()
 * check (settled/refunded/expired) then skipped it on every subsequent
 * sweep run, permanently orphaning the exact case this sweep exists for.
 * findStellarBurn simply finds nothing for an order that expired because
 * the user never sent funds at all, so there's no false-positive risk in
 * still checking expired ones.
 */
export function isPayoutAlreadyResolved(status: PayoutStatus | undefined): boolean {
  return status === "settled" || status === "refunded";
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

      const payout = await getPayoutStatus(orderId);
      if (isPayoutAlreadyResolved(payout?.status)) continue;

      const found = await findBurn(meta);
      if (!found) continue;

      // Already registered — the pipeline has it, just nudge it along.
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
        sourceChain: (meta.sourceChain || "stellar") as OfframpSourceChain,
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


export type OrderRecoveryOutcome =
  | "not-recoverable"
  | "already-resolved"
  | "no-burn-found"
  | "already-registered"
  | "recovered";

export interface OrderRecoveryResult {
  readonly outcome: OrderRecoveryOutcome;
  readonly burnTxHash?: string;
  /** Present whenever the burn was located on-chain, whatever the outcome. */
  readonly amountAtomic?: string;
}

/**
 * Recover ONE order, now.
 *
 * `reconcileUnregisteredBurns` walks every order on a daily cron, which is
 * the wrong cadence for money — a user whose burn stranded should not wait
 * until 03:17 to be paid. The matching was always per-order; only the driver
 * was a loop. This exposes it directly for the two callers that already know
 * a specific order is in trouble: the status poll the user's own page makes
 * while they wait, and the admin dashboard's Register button.
 *
 * Idempotent. Registering is a no-op if a transfer already exists, and the
 * matcher requires both mint recipient and amount to line up, so calling it
 * on a healthy order does nothing.
 */
export async function recoverOrder(
  orderId: string,
  opts: { readonly ignoreGrace?: boolean } = {},
): Promise<OrderRecoveryResult> {
  const meta = await getOrderMeta(orderId);

  // The grace period stops the daily sweep racing a client that is still
  // mid-flow. An admin clicking Register, or a poll for an order whose
  // client already failed, has better information than that timer.
  if (opts.ignoreGrace) {
    if (!meta?.senderAddress || !meta.receiveAddress) {
      return { outcome: "not-recoverable" };
    }
  } else if (!orderRecoverable(meta)) {
    return { outcome: "not-recoverable" };
  }

  const payout = await getPayoutStatus(orderId);
  if (isPayoutAlreadyResolved(payout?.status)) return { outcome: "already-resolved" };

  const found = await findBurn(meta!);
  if (!found) return { outcome: "no-burn-found" };

  if (await getCctpTransfer(found.burnTxHash)) {
    // Registered but stalled in attest/mint — nudge it rather than re-register.
    await advanceCctpTransfer(found.burnTxHash).catch(() => {});
    return {
      outcome: "already-registered",
      burnTxHash: found.burnTxHash,
      amountAtomic: found.amountAtomic,
    };
  }

  await registerOfframpBurn({
    burnTxHash: found.burnTxHash,
    mintRecipient: meta!.receiveAddress!,
    amount:
      meta!.amountUsdc != null
        ? String(meta!.amountUsdc)
        : (Number(found.amountAtomic) / 1e6).toString(),
    paycrestOrderId: orderId,
    sourceChain: (meta!.sourceChain || "stellar") as OfframpSourceChain,
    connectedAddress: meta!.senderAddress!,
  });
  await advanceCctpTransfer(found.burnTxHash).catch(() => {});

  console.log(`[burn-backstop] recovered ${orderId} on demand: ${found.burnTxHash}`);
  return {
    outcome: "recovered",
    burnTxHash: found.burnTxHash,
    amountAtomic: found.amountAtomic,
  };
}
