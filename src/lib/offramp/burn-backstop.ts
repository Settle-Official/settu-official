// Recovers a CCTP offramp burn whose client-side registration never landed —
// the mint recipient is fixed at burn time, so nothing else will ever mint it.
// Covers every burning chain (Stellar, Solana, EVM); Base transfers directly.

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

interface FoundBurn {
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
    const amountAtomic = msg.amount ?? "0";
    if (burnMatches(msg.mintRecipient, amountAtomic, target, expected)) {
      return { burnTxHash: txHash, amountAtomic };
    }
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
  if (!res.ok) return null;
  const signatures: any[] = (await res.json())?.result ?? [];
  const target = low20(receiveAddress);

  for (const entry of signatures) {
    if (entry?.err || !entry?.signature) continue;

    let msg;
    try {
      msg = await fetchBurnMessage({
        sourceDomain: SOLANA_CCTP_DOMAIN,
        transactionHash: entry.signature,
      });
    } catch {
      continue; // Iris hiccup — try the next candidate
    }
    if (!msg?.mintRecipient) continue; // not a CCTP burn
    const amountAtomic = msg.amount ?? "0";
    if (burnMatches(msg.mintRecipient, amountAtomic, target, expected)) {
      return { burnTxHash: entry.signature, amountAtomic };
    }
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
async function findBurn(meta: OrderMeta): Promise<FoundBurn | null> {
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

function orderRecoverable(meta: OrderMeta | null): meta is OrderMeta {
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
