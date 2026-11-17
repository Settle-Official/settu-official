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
import { readBridgedEvent, type BridgedEvent } from "./read-source-event";

export const SELF_CLAIM_AFTER_MS = 30 * 60 * 1000;

export type BridgeViewStatus = "submitted" | "verifying" | "delivering" | "completed" | "failed";

export interface BridgeStatusView {
  id: string;
  status: BridgeViewStatus;
  source: string;
  dest: string;
  recipient: string;
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
  constructor(message: string, status: number = 400) {
    super(message);
    this.status = status;
    this.name = "BridgeRegisterError";
  }
}

export interface BridgeStoreDeps {
  readEvent(chain: BridgeChainKey, txHash: string): Promise<BridgedEvent | null>;
  get(id: string): Promise<CctpTransferRecord | null>;
  create(
    r: Omit<CctpTransferRecord, "createdAt" | "updatedAt" | "attempts">,
  ): Promise<CctpTransferRecord>;
  now(): number;
}

const defaultDeps: BridgeStoreDeps = {
  readEvent: (c, h) => readBridgedEvent(c, h),
  get: getCctpTransfer,
  create: createCctpTransfer,
  now: Date.now,
};

function normaliseHash(chain: BridgeChainKey, txHash: string): string | null {
  const family = BRIDGE_CHAINS[chain].family;
  if (family === "evm") return /^0x[0-9a-fA-F]{64}$/.test(txHash) ? txHash.toLowerCase() : null;
  if (family === "stellar") return /^[0-9a-fA-F]{64}$/.test(txHash) ? txHash.toLowerCase() : null;
  return null;
}

/** Last 20 bytes for an EVM destination; otherwise the raw bytes32 hex. */
function recipientFrom(destFamily: string, mintRecipient: string): string {
  return destFamily === "evm" ? `0x${mintRecipient.slice(-40)}` : mintRecipient;
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
  if (!record) {
    let ev: BridgedEvent | null;
    try {
      ev = await deps.readEvent(chain, id);
    } catch (e) {
      console.error("[bridge/register] read failed:", e instanceof Error ? e.message : "unknown");
      throw new BridgeRegisterError("Could not read the transaction. Try again shortly.", 503);
    }
    if (!ev) throw new BridgeRegisterError("No Settu bridge event found in that transaction.");

    let dest;
    try {
      dest = bridgeChainByDomain(ev.destDomain);
    } catch {
      throw new BridgeRegisterError("Transaction targets an unknown destination.");
    }
    const fast = ev.minFinality === 1000;
    const meta: BridgeMeta = {
      source: chain,
      dest: dest.key,
      user: ev.user,
      recipient: recipientFrom(dest.family, ev.mintRecipient),
      speed: fast ? "fast" : "standard",
      quoteNonce: ev.nonce,
      sendAtomic: ev.amount.toString(),
      settuFeeAtomic: ev.settuFee.toString(),
      networkFeeAtomic: ev.networkFee.toString(),
      fastFeeMaxAtomic: "0",
      // Fast: Circle's maxFee isn't emitted, so the burn amount stands in.
      receiveMinAtomic: (fast ? ev.amount : ev.amount - ev.settuFee - ev.networkFee).toString(),
      ...(fast ? { receiveMinIsBurn: true } : {}),
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
    recipient: m.recipient,
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
