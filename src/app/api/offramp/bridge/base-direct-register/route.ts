import { NextRequest, NextResponse } from "next/server";
import { recordTransaction } from "@/lib/offramp/transaction-history";
import { validateAmount, validateAddress } from "@/lib/offramp/utils/validation";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      txHash,
      connectedAddress,
      amountUsdc,
      destinationCurrency,
      destinationAmount,
      paycrestOrderId,
    } = body;

    if (!txHash || !validateAddress(connectedAddress, "base") || !validateAmount(amountUsdc)) {
      return NextResponse.json(
        { error: "txHash, connectedAddress, and amountUsdc are required" },
        { status: 400 },
      );
    }

    const record = await recordTransaction({
      id: txHash,
      sourceChain: "base",
      connectedAddress,
      amountUsdc,
      mintTxHash: txHash, // Base's own transfer tx IS the settlement tx -- no separate mint
      destinationCurrency: destinationCurrency || "NGN",
      destinationAmount: destinationAmount || "0",
      paycrestOrderId,
      // Registration only means the USDC left the user's wallet, not that
      // anyone was paid — this used to claim "completed" here, which made
      // every Base offramp look settled the instant it started, including
      // ones that later failed. The webhook and the status poll now move it
      // to completed/failed once Paycrest says what actually happened.
      status: "pending",
    });

    return NextResponse.json({ id: record.id });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to register transaction" },
      { status: 500 },
    );
  }
}
