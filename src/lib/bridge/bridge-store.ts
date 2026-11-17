/**
 * Bridge records: registration (values from the on-chain event, never the
 * client) and the status view the UI polls. Records live in the CCTP store
 * with direction "bridge".
 */

import {
  createCctpTransfer,
  getCctpTransfer,
  type BridgeMeta,
  type CctpTransferRecord,
} from "../cctp/cctp-store";
import { BRIDGE_CHAINS, bridgeChainByDomain, type BridgeChainKey } from "./chains";
import { PublicKey } from "@solana/web3.js";
import { loadQuoteRecord, type QuoteRecord } from "./quote-record";
import { InvalidEventError, readBridgedEvent, TxNotIndexedError, type BridgedEvent } from "./read-source-event";

export const SELF_CLAIM_AFTER_MS = 30 * 60 * 1000;

export type BridgeViewStatus = "submitted" | "verifying" | "delivering" | "completed" | "failed";

export interface BridgeStatusView {
  id: string;
  status: BridgeViewStatus;
  source: string;
  dest: string;
  recipient?: string;
  recipientIsTokenAccount?: boolean;
  recipientUnknown?: boolean;
  sendAtomic: string;
  receiveMinAtomic: string;
  receivedAtomic?: string;
  sourceTx: string;
  destTx?: string;
  canSelfClaim: boolean;
  fellBackToStandard: boolean;
}

export class BridgeRegisterError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number = 400, code: string = "invalid_request") {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "BridgeRegisterError";
  }
}

export interface BridgeStoreDeps {
  readEvent(chain: BridgeChainKey, txHash: string): Promise<BridgedEvent | null>;
  getQuote(nonce: string): Promise<QuoteRecord | null>;
  get(id: string): Promise<CctpTransferRecord | null>;
  create(
    r: Omit<CctpTransferRecord, "createdAt" | "updatedAt" | "attempts">,
  ): Promise<CctpTransferRecord>;
  now(): number;
}

const defaultDeps: BridgeStoreDeps = {
  readEvent: (c, h) => readBridgedEvent(c, h),
  getQuote: async (n) => {
    try {
      return await loadQuoteRecord(n);
    } catch {
      return null; // best-effort join; fall back to what the event proves
    }
  },
  get: getCctpTransfer,
  // createCctpTransfer writes the record, pending entry and explorer index in one MULTI.
  create: createCctpTransfer,
  now: Date.now,
};

function normaliseHash(chain: BridgeChainKey, txHash: string): string | null {
  const family = BRIDGE_CHAINS[chain].family;
  if (family === "evm") return /^0x[0-9a-fA-F]{64}$/.test(txHash) ? txHash.toLowerCase() : null;
  if (family === "stellar") return /^[0-9a-fA-F]{64}$/.test(txHash) ? txHash.toLowerCase() : null;
  return null;
}

/** What the event alone proves about the recipient. */
function fallbackRecipient(
  destFamily: string,
  mintRecipient: string,
): Pick<BridgeMeta, "recipient" | "recipientIsTokenAccount" | "recipientUnknown"> {
  if (destFamily === "evm") return { recipient: `0x${mintRecipient.slice(-40)}` };
  if (destFamily === "solana") {
    return {
      recipient: new PublicKey(Buffer.from(mintRecipient.slice(2), "hex")).toBase58(),
      recipientIsTokenAccount: true,
    };
  }
  return { recipientUnknown: true };
}

export async function registerBridge(
  chain: BridgeChainKey,
  txHash: string,
  onRegistered: (id: string) => Promise<void> = async () => {},
  deps: BridgeStoreDeps = defaultDeps,
): Promise<CctpTransferRecord> {
  if (!(chain in BRIDGE_CHAINS)) throw new BridgeRegisterError("Unknown chain.");
  if (BRIDGE_CHAINS[chain].family === "solana") {
    throw new BridgeRegisterError("Solana source is not supported yet.");
  }
  const id = normaliseHash(chain, txHash);
  if (!id) throw new BridgeRegisterError("Invalid transaction hash.");

  let record = await deps.get(id);
  if (record && (record.direction !== "bridge" || !record.bridge)) {
    throw new BridgeRegisterError("That transaction is not a bridge transfer.", 400, "not_a_bridge");
  }
  if (!record) {
    let ev: BridgedEvent | null;
    try {
      ev = await deps.readEvent(chain, id);
    } catch (e) {
      if (e instanceof TxNotIndexedError) {
        throw new BridgeRegisterError("Transaction not confirmed yet. Try again shortly.", 409, "not_indexed");
      }
      if (e instanceof InvalidEventError) {
        throw new BridgeRegisterError("That transaction's bridge event is invalid.", 400, "invalid_event");
      }
      console.error("[bridge/register] read failed:", e instanceof Error ? e.message : "unknown");
      throw new BridgeRegisterError("Could not read the transaction. Try again shortly.", 503, "unavailable");
    }
    if (!ev) throw new BridgeRegisterError("No Settu bridge event found in that transaction.", 400, "no_event");

    let dest;
    try {
      dest = bridgeChainByDomain(ev.destDomain);
    } catch {
      throw new BridgeRegisterError("Transaction targets an unknown destination.");
    }
    const fast = ev.minFinality === 1000;
    const speed = fast ? "fast" : "standard";
    const q = await deps.getQuote(ev.nonce);
    // Only trust the quote record if it describes this very transfer.
    const quote =
      q &&
      q.source === chain &&
      q.dest === dest.key &&
      q.speed === speed &&
      q.user.toLowerCase() === ev.user.toLowerCase()
        ? q
        : null;
    const burn = ev.amount - ev.settuFee - ev.networkFee;
    const meta: BridgeMeta = {
      source: chain,
      dest: dest.key,
      user: ev.user,
      ...(quote
        ? { recipient: quote.recipient }
        : fallbackRecipient(dest.family, ev.mintRecipient)),
      speed,
      quoteNonce: ev.nonce,
      sendAtomic: ev.amount.toString(),
      settuFeeAtomic: ev.settuFee.toString(),
      networkFeeAtomic: ev.networkFee.toString(),
      nativeFeeAtomic: ev.nativeFee.toString(),
      fastFeeMaxAtomic: quote ? quote.maxFeeAtomic : "0",
      receiveMinAtomic: quote ? quote.receiveMinAtomic : burn.toString(),
      ...(quote ? {} : { receiveMinIsBurn: true }),
    };
    record = await deps.create({
      id,
      direction: "bridge",
      bridge: meta,
      sourceDomain: BRIDGE_CHAINS[chain].cctpDomain,
      destDomain: ev.destDomain,
      burnTxHash: id,
      mintRecipient: ev.mintRecipient,
      status: "burned",
    });
  }

  try {
    await onRegistered(id);
  } catch (e) {
    console.error("[bridge/register] onRegistered failed:", e instanceof Error ? e.message : "unknown");
  }
  return record;
}

const VIEW_STATUS: Record<CctpTransferRecord["status"], BridgeViewStatus> = {
  burned: "verifying",
  attesting: "verifying",
  attested: "delivering",
  minting: "delivering",
  completed: "completed",
  failed: "failed",
};

export function toStatusView(r: CctpTransferRecord, now: number = Date.now()): BridgeStatusView {
  const m = r.bridge;
  if (!m) throw new Error("not a bridge record");
  return {
    id: r.id,
    status: VIEW_STATUS[r.status],
    source: m.source,
    dest: m.dest,
    ...(m.recipient !== undefined ? { recipient: m.recipient } : {}),
    ...(m.recipientIsTokenAccount ? { recipientIsTokenAccount: true } : {}),
    ...(m.recipientUnknown ? { recipientUnknown: true } : {}),
    sendAtomic: m.sendAtomic,
    receiveMinAtomic: m.receiveMinAtomic,
    ...(m.receivedAtomic !== undefined ? { receivedAtomic: m.receivedAtomic } : {}),
    sourceTx: r.burnTxHash,
    ...(r.mintTxHash ? { destTx: r.mintTxHash } : {}),
    canSelfClaim:
      r.status === "attested" &&
      m.attestedAt !== undefined &&
      now - m.attestedAt >= SELF_CLAIM_AFTER_MS,
    fellBackToStandard: m.fellBackToStandard === true,
  };
}

export async function getBridgeStatus(
  id: string,
  deps: Pick<BridgeStoreDeps, "get" | "now"> = defaultDeps,
): Promise<BridgeStatusView | null> {
  const r = await deps.get(id.toLowerCase());
  if (!r || r.direction !== "bridge" || !r.bridge) return null;
  return toStatusView(r, deps.now());
}
