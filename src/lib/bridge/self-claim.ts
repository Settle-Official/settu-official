/**
 * "Claim it yourself" (spec §9): every bridge burns with destinationCaller 0,
 * so once Circle has attested it, anyone can submit the mint. When Settu's
 * relayer hasn't delivered, the user's own destination wallet can, paying the
 * gas itself. The server builds the unsigned tx from the stored attestation;
 * the browser wallet only signs and sends it.
 *
 * Ruling AJ: EVM destinations only for now. Stellar (`mint_and_forward`) and
 * Solana (`receive_message` with its account list and lookup table) need
 * their own client-side builders; until then those users rely on the relayer
 * and support, and the button doesn't appear.
 */

import { encodeFunctionData, type Hex } from "viem";
import { EVM_MESSAGE_TRANSMITTER_V2 } from "../cctp/constants";
import type { CctpTransferRecord } from "../cctp/cctp-store";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";

export class SelfClaimError extends Error {
  readonly code: "not_claimable" | "unsupported_dest" | "not_minted";
  constructor(code: SelfClaimError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "SelfClaimError";
  }
}

export interface SelfClaimTx {
  family: "evm";
  chainId: number;
  to: Hex;
  data: Hex;
}

const RECEIVE_MESSAGE_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** States where Circle has attested but the mint may not have landed. */
const CLAIMABLE = new Set<CctpTransferRecord["status"]>(["attested", "minting", "failed"]);

export function isSelfClaimableDest(dest: BridgeChainKey): boolean {
  return BRIDGE_CHAINS[dest].family === "evm";
}

export function buildSelfClaimTx(r: CctpTransferRecord): SelfClaimTx {
  const dest = r.bridge?.dest as BridgeChainKey | undefined;
  if (!dest || !(dest in BRIDGE_CHAINS)) throw new SelfClaimError("not_claimable", "Not a bridge.");
  if (!isSelfClaimableDest(dest)) {
    throw new SelfClaimError(
      "unsupported_dest",
      `Claiming on ${BRIDGE_CHAINS[dest].label} from the app isn't available yet. Settu is still delivering it.`,
    );
  }
  if (!CLAIMABLE.has(r.status) || !r.attestationMessage || !r.attestationSignature) {
    throw new SelfClaimError("not_claimable", "This bridge can't be claimed right now.");
  }
  const chainId = BRIDGE_CHAINS[dest].chainId;
  if (!chainId) throw new SelfClaimError("unsupported_dest", "No chain id for that destination.");
  return {
    family: "evm",
    chainId,
    to: EVM_MESSAGE_TRANSMITTER_V2,
    data: encodeFunctionData({
      abi: RECEIVE_MESSAGE_ABI,
      functionName: "receiveMessage",
      args: [r.attestationMessage as Hex, r.attestationSignature as Hex],
    }),
  };
}

// ---------------------------------------------------------------- confirming a claim

export interface ConfirmClaimDeps {
  get(id: string): Promise<CctpTransferRecord | null>;
  /** True when this message's nonce is used on the destination transmitter. */
  isMinted(dest: BridgeChainKey, messageHex: string): Promise<boolean>;
  readReceivedAtomic(dest: BridgeChainKey, tx: string, ctx: { mintRecipient: string }): Promise<bigint>;
  update(id: string, patch: Partial<CctpTransferRecord>): Promise<unknown>;
  recordCompleted(r: CctpTransferRecord): Promise<unknown>;
}

/**
 * After the user's own wallet submits the mint ("Claim it yourself"), mark the
 * bridge completed. A failed bridge is terminal for the server's driver, so
 * without this a successful claim would read as failed forever.
 *
 * Two on-chain checks, so a client can't complete a bridge with someone
 * else's mint: this bridge's own message must be minted, and `claimTx` must
 * have minted USDC to this bridge's recipient (which also gives the amount).
 */
export async function confirmSelfClaim(
  id: string,
  claimTx: string,
  d: ConfirmClaimDeps = defaultConfirmClaimDeps(),
): Promise<CctpTransferRecord> {
  const r = await d.get(id);
  if (!r || r.direction !== "bridge" || !r.bridge) throw new SelfClaimError("not_claimable", "Not a bridge.");
  if (r.status === "completed") return r;
  const dest = r.bridge.dest as BridgeChainKey;
  if (!(dest in BRIDGE_CHAINS) || !isSelfClaimableDest(dest)) {
    throw new SelfClaimError("unsupported_dest", "This bridge can't be claimed from the app.");
  }
  if (!CLAIMABLE.has(r.status) || !r.attestationMessage) {
    throw new SelfClaimError("not_claimable", "This bridge can't be claimed right now.");
  }
  if (!(await d.isMinted(dest, r.attestationMessage))) {
    throw new SelfClaimError("not_minted", "The claim hasn't landed yet. Try again in a moment.");
  }
  const received = await d.readReceivedAtomic(dest, claimTx, { mintRecipient: r.mintRecipient });
  const patch: Partial<CctpTransferRecord> = {
    status: "completed",
    mintTxHash: claimTx,
    lastError: undefined,
    bridge: { ...r.bridge, receivedAtomic: received.toString() },
  };
  await d.update(id, patch);
  const done = { ...r, ...patch } as CctpTransferRecord;
  try {
    await d.recordCompleted(done);
  } catch (e) {
    console.error("[self-claim] ledger write failed:", id, e instanceof Error ? e.message : "unknown");
  }
  return done;
}

export function defaultConfirmClaimDeps(): ConfirmClaimDeps {
  return {
    get: async (id) => (await import("../cctp/cctp-store")).getCctpTransfer(id),
    isMinted: async (dest, messageHex) => {
      const [{ isMessageAlreadyMinted }, { createPublicClient, http }] = await Promise.all([
        import("../cctp/base-cctp"),
        import("viem"),
      ]);
      const rpc = process.env[BRIDGE_CHAINS[dest].rpcEnvVar];
      if (!rpc) throw new Error(`${BRIDGE_CHAINS[dest].rpcEnvVar} is not set`);
      return isMessageAlreadyMinted(createPublicClient({ transport: http(rpc) }), EVM_MESSAGE_TRANSMITTER_V2, messageHex);
    },
    readReceivedAtomic: async (dest, tx, ctx) => (await import("./received-amount")).readReceivedAtomic(dest, tx, ctx),
    update: async (id, patch) => (await import("../cctp/cctp-store")).updateCctpTransfer(id, patch),
    recordCompleted: async (r) => (await import("./bridge-ledger")).recordCompletedBridge(r),
  };
}
