import { NextRequest, NextResponse } from "next/server";
import { createCctpTransfer, getCctpTransfer } from "@/lib/cctp/cctp-store";
import { recordLedgerEntry } from "@/lib/ledger/funds-ledger";
import { CCTP_DOMAIN } from "@/lib/cctp/constants";
import { EVM_SOURCE_CHAINS, isCctpBridgeChain, type EvmChainKey } from "@/lib/cctp/evm-chains";
import { recordTransaction, type OfframpSourceChain } from "@/lib/offramp/transaction-history";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      burnTxHash,
      mintRecipient,
      amount,
      paycrestOrderId,
      // "stellar" | EvmChainKey — omitted by the existing Stellar-only client,
      // in which case we default to Stellar's domain (fully backward-compatible).
      sourceChain,
      // The wallet that signed the burn — recorded in the permanent
      // cross-chain transaction history. Optional; the Stellar client does
      // not send it today.
      connectedAddress,
    } = body;

    if (!burnTxHash || !mintRecipient || !amount) {
      return NextResponse.json(
        { error: "burnTxHash, mintRecipient, and amount are required" },
        { status: 400 },
      );
    }

    const resolvedSourceChain: OfframpSourceChain = sourceChain || "stellar";
    let sourceDomain: number | undefined;
    if (resolvedSourceChain === "stellar") {
      sourceDomain = CCTP_DOMAIN.stellar;
    } else {
      const chainConfig = EVM_SOURCE_CHAINS[resolvedSourceChain as EvmChainKey];
      // Only CCTP-bridge chains route through this attest/mint pipeline —
      // Base's direct transfer has its own register route and never lands here.
      if (chainConfig && isCctpBridgeChain(chainConfig)) {
        sourceDomain = chainConfig.cctpDomain;
      }
    }
    if (sourceDomain === undefined) {
      return NextResponse.json(
        { error: `Unknown or non-bridging source chain: ${resolvedSourceChain}` },
        { status: 400 },
      );
    }

    // Idempotent: the client now retries this call (a real burn getting
    // orphaned here — burned on-chain with no record, never mintable
    // automatically — is exactly the failure mode that stranded a real
    // user's funds), so a repeat call for a burn already registered must be
    // a safe no-op rather than re-running createCctpTransfer (which does an
    // unconditional overwrite and would reset an already-advancing record
    // back to "burned"/attempts:0) or recordLedgerEntry (which always
    // allocates a fresh id — a second call would double the permanent audit
    // entry for one real burn).
    const existing = await getCctpTransfer(burnTxHash);
    if (existing) {
      return NextResponse.json({ transferId: existing.id });
    }

    // The burn tx hash is already unique per transfer, and the client already
    // has it (it's what pollBridgeStatus/the SSE stream key off) — using it
    // as the record id avoids maintaining a second, separate identifier.
    const record = await createCctpTransfer({
      id: burnTxHash,
      direction: "offramp",
      sourceDomain,
      destDomain: CCTP_DOMAIN.base,
      burnTxHash,
      mintRecipient,
      status: "burned",
      paycrestOrderId,
    });

    await recordLedgerEntry({
      direction: "offramp",
      chain: resolvedSourceChain,
      asset: "USDC",
      amount,
      txHash: burnTxHash,
      orderId: paycrestOrderId,
    });

    if (connectedAddress) {
      // Fire-and-forget — the transfer is already registered above; a
      // history-write failure must not fail the request and re-strand the burn.
      void recordTransaction({
        id: burnTxHash,
        sourceChain: resolvedSourceChain,
        connectedAddress,
        amountUsdc: amount,
        burnTxHash,
        destinationCurrency: "NGN", // widen if/when other corridors reach this route
        destinationAmount: "0", // filled in once the payout is known
        paycrestOrderId,
      });
    }

    return NextResponse.json({ transferId: record.id });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to register transfer" },
      { status: 500 },
    );
  }
}
