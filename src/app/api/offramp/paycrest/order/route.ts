import { NextRequest, NextResponse } from "next/server";
import { PaycrestAdapter } from "@/lib/offramp/adapters/paycrest-adapter";
import { setOrderMeta } from "@/lib/offramp/order-meta-store";
import { alertOfframpEvent } from "@/lib/notify/telegram";

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.PAYCREST_API_KEY;
    if (!apiKey) {
      throw new Error("PAYCREST_API_KEY not configured");
    }

    const body = await request.json();
    const amount = Number(body?.amount);
    const rate = Number(body?.rate);
    const token = String(body?.token || "").toUpperCase();
    const network = String(body?.network || "base").toLowerCase();
    const reference = String(body?.reference || "");
    const returnAddress = String(body?.returnAddress || "");
    const providerId = body?.recipient?.providerId
      ? String(body.recipient.providerId).trim()
      : "";

    const recipient = {
      institution: String(body?.recipient?.institution || "").trim(),
      accountIdentifier: String(body?.recipient?.accountIdentifier || "").trim(),
      accountName: String(body?.recipient?.accountName || "").trim(),
      memo: body?.recipient?.memo
        ? String(body.recipient.memo).trim()
        : "Settu offramp",
      metadata: body?.recipient?.metadata ?? {},
      currency: String(body?.recipient?.currency || "").toUpperCase(),
    };

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isFinite(rate) ||
      rate <= 0 ||
      !token ||
      !returnAddress ||
      !recipient.institution ||
      !recipient.accountIdentifier ||
      !recipient.accountName ||
      !recipient.currency
    ) {
      return NextResponse.json(
        {
          error: "Invalid order payload",
          message: "One or more required fields are missing/invalid",
          details: {
            amount,
            rate,
            token,
            network,
            hasReturnAddress: Boolean(returnAddress),
            recipient,
          },
        },
        { status: 400 }
      );
    }

    const normalizedPayload = {
      amount,
      token,
      rate,
      network,
      recipient: {
        ...recipient,
        ...(providerId ? { providerId } : {}),
      },
      reference: reference || undefined,
      returnAddress,
    };

    
    const paycrest = new PaycrestAdapter(apiKey);

    const order = await paycrest.createOrder(normalizedPayload as any);

    const orderId: string | undefined = (order as any)?.id;
    const payoutValue = Number((amount * rate).toFixed(2));

    // Persist metadata (bank details, rate, payout value) so webhook alerts —
    // whose payload lacks these — can be enriched later. Best-effort.
    if (orderId) {
      void setOrderMeta(orderId, {
        institution: recipient.institution,
        accountIdentifier: recipient.accountIdentifier,
        accountName: recipient.accountName,
        currency: recipient.currency,
        amountUsdc: amount,
        rate,
        payoutValue,
        reference: reference || undefined,
        network,
        receiveAddress: (order as any)?.receiveAddress || undefined,
      }).catch(() => {});
    }

    // Guaranteed per-transaction alert — fires even if webhooks aren't wired up.
    void alertOfframpEvent({
      orderId: orderId ?? "(no id)",
      status: "created",
      accountName: recipient.accountName,
      accountNumber: recipient.accountIdentifier,
      bank: recipient.institution,
      currency: recipient.currency,
      amountUsdc: amount,
      rate,
      payoutValue,
      reference: reference || undefined,
    });

    return NextResponse.json({ data: order });
  } catch (error: any) {
    const statusCode =
      typeof error?.status === "number" && error.status >= 400
        ? error.status
        : 500;

    
    return NextResponse.json(
      { 
        error: error.message || "Failed to create Paycrest order",
        message: error.message,
        details: error?.details || null,
      },
      { status: statusCode }
    );
  }
}
