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
  readonly code: "not_claimable" | "unsupported_dest";
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
