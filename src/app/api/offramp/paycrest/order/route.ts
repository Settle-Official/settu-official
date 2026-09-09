import { NextRequest, NextResponse } from "next/server";
import { PaycrestAdapter } from "@/lib/offramp/adapters/paycrest-adapter";
import { setOrderMeta } from "@/lib/offramp/order-meta-store";
import { alertOfframpEvent } from "@/lib/notify/telegram";
import { selectTopProviders } from "@/lib/offramp/provider-routing";
import { PLATFORM_FEE_RATE } from "@/lib/offramp/fiat-conversion";
import { validateAddress } from "@/lib/offramp/utils/validation";

// How far the live book rate may fall below the rate the client was quoted
// before we refuse to place the order. The quote's own 5-minute validUntil is
// never enforced, so without this a stale quote can silently reprice the user.
const RATE_DRIFT_TOLERANCE = 0.005;

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

    // Untrusted and unverified in this phase — validated only so a malformed
    // value can never reach a Redis key, and never blocks the payout.
    const claimedAddress = String(body?.userStellarAddress || "").trim();
    const userStellarAddress = validateAddress(claimedAddress, "stellar")
      ? claimedAddress
      : undefined;
    const grossCandidate = Number(body?.grossAmountUsdc);
    const grossAmountUsdc =
      Number.isFinite(grossCandidate) && grossCandidate > 0
        ? grossCandidate
        : undefined;

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

    const paycrest = new PaycrestAdapter(apiKey);

    // Select the provider queue here rather than trusting the client: the quote
    // prices the bridge-quote's receiveAmount, while this route is handed an
    // amount derived from a *second* bridge quote. Tier bands are exact, so a
    // drifted amount can qualify for a different band than the quote saw.
    let providerIds: string[] = providerId ? [providerId] : [];
    let rateSource: "book" | "client" = "client";
    let finalRate = rate;

    if (!providerId) {
      try {
        const book = await paycrest.getMarketBook({
          side: "sell",
          fiat: recipient.currency,
          token,
          network,
        });
        const selection = selectTopProviders(book, {
          amount,
          side: "sell",
          fiat: recipient.currency,
          token,
          network,
        });

        if (selection.providerIds.length > 0) {
          // Never silently pay the user less than they were quoted. Drift beyond
          // the tolerance means the book moved under a stale quote — surface it
          // so the client can re-quote instead of repricing behind their back.
          if (selection.rate < rate * (1 - RATE_DRIFT_TOLERANCE)) {
            return NextResponse.json(
              {
                code: "RATE_MOVED",
                error: "Rate moved since the quote was issued",
                message:
                  "The best available rate has dropped since you were quoted. Please refresh and try again.",
                details: { quotedRate: rate, availableRate: selection.rate },
              },
              { status: 409 },
            );
          }

          providerIds = selection.providerIds;
          rateSource = "book";
          finalRate = selection.rate;
        }
      } catch {
        // Markets unavailable — fall through with no providerIds, which is
        // exactly today's behaviour: Paycrest picks the provider itself.
      }
    }

    const order = await paycrest.createOfframpOrderV2({
      amount,
      token,
      network,
      rate: finalRate,
      currency: recipient.currency,
      recipient,
      refundAddress: returnAddress,
      reference: reference || undefined,
      ...(providerIds.length ? { providerIds } : {}),
    });

    const orderId: string | undefined = (order as any)?.id;
    // Net of the 0.3% Paycrest deducts account-side, so this matches both the
    // quote the user saw and what actually lands in their bank. Also persisted
    // to OrderMeta, so later webhook alerts inherit the corrected figure.
    const payoutValue = Number(
      (amount * finalRate * (1 - PLATFORM_FEE_RATE)).toFixed(2),
    );

    // Persist metadata (bank details, rate, payout value) so webhook alerts —
    // whose payload lacks these — can be enriched later. Best-effort.
    if (orderId) {
      void setOrderMeta(orderId, {
        institution: recipient.institution,
        accountIdentifier: recipient.accountIdentifier,
        accountName: recipient.accountName,
        currency: recipient.currency,
        amountUsdc: amount,
        rate: finalRate,
        payoutValue,
        reference: reference || undefined,
        network,
        receiveAddress: (order as any)?.receiveAddress || undefined,
        providerIds,
        rateSource,
        userStellarAddress,
        attributionSource: userStellarAddress ? "client" : undefined,
        grossAmountUsdc,
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
      rate: finalRate,
      payoutValue,
      reference: reference || undefined,
    });

    return NextResponse.json({ data: order, providerIds, rateSource });
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
