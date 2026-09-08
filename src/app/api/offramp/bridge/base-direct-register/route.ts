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
      status: "completed",
    });

    return NextResponse.json({ id: record.id });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to register transaction" },
      { status: 500 },
    );
  }
}
