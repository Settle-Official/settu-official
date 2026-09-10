import { createCctpTransfer, getCctpTransfer } from "./cctp-store";
import { recordLedgerEntry } from "../ledger/funds-ledger";
import { CCTP_DOMAIN } from "./constants";
import {
  EVM_SOURCE_CHAINS,
  isCctpBridgeChain,
  type EvmChainKey,
} from "./evm-chains";
import { SOLANA_CCTP_DOMAIN } from "../solana/config";
import {
  recordTransaction,
  type OfframpSourceChain,
} from "../offramp/transaction-history";

/**
 * Maps an offramp source chain to its CCTP source domain, or undefined for a
 * chain that doesn't route through the attest/mint pipeline (Base's direct
 * transfer). `"stellar"` when omitted, for the original Stellar-only client.
 */
export function offrampSourceDomain(
  sourceChain: OfframpSourceChain | undefined,
): number | undefined {
  const resolved: OfframpSourceChain = sourceChain || "stellar";
  if (resolved === "stellar") return CCTP_DOMAIN.stellar;
  if (resolved === "solana") return SOLANA_CCTP_DOMAIN;
  const chainConfig = EVM_SOURCE_CHAINS[resolved as EvmChainKey];
  if (chainConfig && isCctpBridgeChain(chainConfig)) return chainConfig.cctpDomain;
  return undefined;
}

export interface RegisterOfframpBurnInput {
  burnTxHash: string;
  mintRecipient: string;
  amount: string;
  paycrestOrderId?: string;
  sourceChain?: OfframpSourceChain;
  /** The wallet that signed the burn — recorded in cross-chain history. */
  connectedAddress?: string;
}

/**
 * Registers a confirmed CCTP offramp burn so the attest→mint state machine
 * (SSE stream, daily cron, or burn-backstop sweep) will carry it to a mint on
 * Base. Idempotent — a repeat call for an already-registered burn is a no-op
 * that returns the existing transfer id, so the client's retries and the
 * server-side sweep can't corrupt an already-advancing record or double the
 * ledger entry.
 *
 * Shared by the `/api/offramp/bridge/register-transfer` route (client-driven,
 * right after the burn) and `reconcileUnregisteredBurns` (server-driven, for a
 * burn whose client registration was lost). Throws `RangeError` for a
 * non-bridging source chain.
 */
export async function registerOfframpBurn(
  input: RegisterOfframpBurnInput,
): Promise<string> {
  const sourceDomain = offrampSourceDomain(input.sourceChain);
  if (sourceDomain === undefined) {
    throw new RangeError(
      `Unknown or non-bridging source chain: ${input.sourceChain}`,
    );
  }
  const resolvedSourceChain: OfframpSourceChain = input.sourceChain || "stellar";

  const existing = await getCctpTransfer(input.burnTxHash);
  if (existing) return existing.id;

  const record = await createCctpTransfer({
    id: input.burnTxHash,
    direction: "offramp",
    sourceDomain,
    destDomain: CCTP_DOMAIN.base,
    burnTxHash: input.burnTxHash,
    mintRecipient: input.mintRecipient,
    status: "burned",
    paycrestOrderId: input.paycrestOrderId,
  });

  await recordLedgerEntry({
    direction: "offramp",
    chain: resolvedSourceChain,
    asset: "USDC",
    amount: input.amount,
    txHash: input.burnTxHash,
    orderId: input.paycrestOrderId,
  });

  if (input.connectedAddress) {
    // Fire-and-forget — the transfer is registered above; a history-write
    // failure must not fail the caller and re-strand the burn.
    void recordTransaction({
      id: input.burnTxHash,
      sourceChain: resolvedSourceChain,
      connectedAddress: input.connectedAddress,
      amountUsdc: input.amount,
      burnTxHash: input.burnTxHash,
      destinationCurrency: "NGN", // widen if/when other corridors reach here
      destinationAmount: "0", // filled in once the payout is known
      paycrestOrderId: input.paycrestOrderId,
    });
  }

  return record.id;
}
