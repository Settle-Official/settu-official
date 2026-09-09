import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  SOLANA_CONFIG,
  SOLANA_CCTP_DOMAIN,
  isSolanaEnabled,
  requireSolanaRpcUrl,
} from "@/lib/solana/config";
import {
  buildDepositForBurnIx,
  usdcFloatToSolanaAtomic,
  baseAddressToSolanaMintRecipient,
} from "@/lib/solana/deposit-for-burn";
import { getBurnFeeQuote, computeAtomicFee } from "@/lib/cctp/iris-client";
import { CCTP_DOMAIN } from "@/lib/cctp/constants";
import { withRetry, isNetworkFetchError } from "@/lib/cctp/retry";
import { validateAmount, validateAddress } from "@/lib/offramp/utils/validation";

export const maxDuration = 30;

function toPubkey(value: unknown): PublicKey | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

/**
 * Builds the unsigned Solana CCTP burn transaction for an offramp. The client
 * generates the ephemeral MessageSent event keypair and sends us its public
 * key; we assemble the transaction (a fresh blockhash, compute-budget ixs,
 * and `deposit_for_burn`) and hand it back. The client partial-signs with the
 * event keypair, then the wallet signs + sends. Server holds no key.
 *
 * Mirrors offramp/bridge/evm-build-tx (server builds, client signs).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { amount, ownerAddress, toAddress, eventAccountPubkey } = body;

    if (!validateAmount(amount)) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }
    const owner = toPubkey(ownerAddress);
    if (!owner) {
      return NextResponse.json({ error: "Invalid Solana wallet address" }, { status: 400 });
    }
    const eventAccount = toPubkey(eventAccountPubkey);
    if (!eventAccount) {
      return NextResponse.json({ error: "Invalid event account key" }, { status: 400 });
    }
    if (!validateAddress(toAddress, "base")) {
      return NextResponse.json({ error: "Invalid Paycrest receive address" }, { status: 400 });
    }
    if (!isSolanaEnabled()) {
      return NextResponse.json(
        { error: "Solana is not currently enabled as a source chain" },
        { status: 400 },
      );
    }

    const rpcUrl = requireSolanaRpcUrl();

    // Read-only (an ATA read is implicit in getLatestBlockhash's RPC, a fee
    // quote, no broadcast) — safe to retry the whole sequence once.
    const result = await withRetry(async () => {
      const connection = new Connection(rpcUrl, "confirmed");

      const amountAtomic = usdcFloatToSolanaAtomic(amount);
      const feeQuote = await getBurnFeeQuote({
        sourceDomain: SOLANA_CCTP_DOMAIN,
        destDomain: CCTP_DOMAIN.base,
      });
      const maxFeeAtomic = computeAtomicFee(feeQuote.minimumFeeBps, amountAtomic);

      const ownerUsdcAta = getAssociatedTokenAddressSync(
        new PublicKey(SOLANA_CONFIG.usdcMint),
        owner,
      );

      const burnIx = await buildDepositForBurnIx({
        owner,
        ownerUsdcAta,
        amountAtomic,
        mintRecipient: baseAddressToSolanaMintRecipient(toAddress),
        maxFeeAtomic,
        eventAccount,
      });

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");

      const message = new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions: [
          // deposit_for_burn is account-heavy; give it headroom + a small
          // priority fee so it lands on mainnet.
          ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
          burnIx,
        ],
      }).compileToV0Message();

      const tx = new VersionedTransaction(message);

      return {
        transactionBase64: Buffer.from(tx.serialize()).toString("base64"),
        lastValidBlockHeight,
        maxFeeAtomic: maxFeeAtomic.toString(),
      };
    });

    return NextResponse.json(result);
  } catch (error: any) {
    const msg = error?.message || "";
    const userMessage = isNetworkFetchError(error)
      ? "Couldn't reach the Solana network right now. Please try again in a moment."
      : msg || "Failed to build transaction";
    return NextResponse.json({ error: userMessage }, { status: 500 });
  }
}
