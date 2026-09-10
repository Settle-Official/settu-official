import { NextRequest, NextResponse } from "next/server";
import { registerOfframpBurn } from "@/lib/cctp/register-burn";
import type { OfframpSourceChain } from "@/lib/offramp/transaction-history";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      burnTxHash,
      mintRecipient,
      amount,
      paycrestOrderId,
      // "stellar" | EvmChainKey | "solana" — omitted by the original
      // Stellar-only client, which registerOfframpBurn defaults to "stellar".
      sourceChain,
      // The wallet that signed the burn — recorded in the permanent
      // cross-chain transaction history. Optional.
      connectedAddress,
    } = body;

    if (!burnTxHash || !mintRecipient || !amount) {
      return NextResponse.json(
        { error: "burnTxHash, mintRecipient, and amount are required" },
        { status: 400 },
      );
    }

    const transferId = await registerOfframpBurn({
      burnTxHash,
      mintRecipient,
      amount,
      paycrestOrderId,
      sourceChain: sourceChain as OfframpSourceChain | undefined,
      connectedAddress,
    });

    return NextResponse.json({ transferId });
  } catch (error: any) {
    if (error instanceof RangeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error?.message || "Failed to register transfer" },
      { status: 500 },
    );
  }
}
