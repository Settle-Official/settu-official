import { NextRequest, NextResponse } from "next/server";
import { PaycrestAdapter } from "@/lib/offramp/adapters/paycrest-adapter";
import { createOnrampOrder } from "@/lib/onramp/onramp-store";
import { validateAddress, validateAmount } from "@/lib/offramp/utils/validation";
import { alertRampEvent } from "@/lib/notify/telegram";

/**
 * Create an onramp order.
 *
 * The user pays fiat into the returned virtual account. Paycrest delivers USDC
 * to the PLATFORM Base hot wallet (not the user — Paycrest has no Stellar
 * support). On the `settled` webhook the server bridges Base→Stellar to the
 * user's address, which is persisted here keyed by order id.
 */
export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.PAYCREST_API_KEY;
    if (!apiKey) {
      throw new Error("PAYCREST_API_KEY not configured");
    }

    const hotWallet = process.env.ONRAMP_HOT_WALLET_ADDRESS;
    if (!hotWallet || !validateAddress(hotWallet, "base")) {
      // Config error — don't expose specifics to the client.
      throw new Error("Onramp hot wallet not configured");
    }

    const body = await request.json();

    const fiatAmount = String(body?.fiatAmount ?? "");
    const currency = String(body?.currency ?? "").toUpperCase();
    const userStellarAddress = String(body?.userStellarAddress ?? "").trim();
    const country = body?.country ? String(body.country).trim() : undefined;
    const rate = body?.rate ? Number(body.rate) : undefined;
    const reference = body?.reference ? String(body.reference) : undefined;

    const refundAccount = {
      institution: String(body?.refundAccount?.institution ?? "").trim(),
      accountIdentifier: String(
        body?.refundAccount?.accountIdentifier ?? "",
      ).trim(),
      accountName: String(body?.refundAccount?.accountName ?? "").trim(),
    };

    // Validation
    if (!validateAmount(fiatAmount)) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }
    if (!currency) {
      return NextResponse.json({ error: "Missing currency" }, { status: 400 });
    }
    if (!validateAddress(userStellarAddress, "stellar")) {
      return NextResponse.json(
        { error: "Invalid Stellar recipient address" },
        { status: 400 },
      );
    }
    if (
      !refundAccount.institution ||
      !refundAccount.accountIdentifier ||
      !refundAccount.accountName
    ) {
      return NextResponse.json(
        { error: "Refund account details are required" },
        { status: 400 },
      );
    }

    const paycrest = new PaycrestAdapter(apiKey);
    const order = await paycrest.createOnrampOrder({
      fiatAmount,
      currency,
      country,
      recipientAddress: hotWallet, // platform Base hot wallet
      network: "base",
      cryptoCurrency: "USDC",
      refundAccount,
      rate,
      reference,
    });

    // Persist the order → user Stellar address mapping so the webhook can bridge
    // to the right wallet later. Also stash refund-account + rate for alert
    // enrichment (the webhook payload lacks them).
    await createOnrampOrder({
      orderId: order.id,
      userStellarAddress,
      fiatAmount,
      currency,
      status: "pending",
      refundInstitution: refundAccount.institution,
      refundAccountIdentifier: refundAccount.accountIdentifier,
      refundAccountName: refundAccount.accountName,
      ...(rate ? { rate } : {}),
    });

    // The rate is what lets the caller record how much USDC this order buys.
    // Paycrest does not always echo one back, and a caller (Agent Mode) may
    // not have sent one, so fall back to the public rate for this corridor —
    // best-effort: a missing rate costs a history figure, never the order.
    let resolvedRate = order.rate ?? (rate ? String(rate) : undefined);
    if (!resolvedRate) {
      resolvedRate = await paycrest
        .getRate("USDC", "1", currency)
        .then((r) => String(r))
        .catch(() => undefined);
    }

    // Guaranteed per-transaction alert — fires even if webhooks aren't wired up.
    void alertRampEvent({
      direction: "onramp",
      orderId: order.id,
      status: "created",
      accountName: refundAccount.accountName,
      accountNumber: refundAccount.accountIdentifier,
      bank: refundAccount.institution,
      currency,
      amountIn: fiatAmount,
      amountInUnit: currency,
      rate,
      payoutUnit: "USDC",
      stellarAddress: userStellarAddress,
    });

    return NextResponse.json({
      data: {
        id: order.id,
        status: order.status,
        providerAccount: order.providerAccount,
        // Both are needed by the caller to record how much USDC the order
        // actually buys. Without them the client stored an empty amount,
        // which read back as 0 — the dashboard's Onramp tile sat at $0 and
        // the history row showed no Worth and no Rate.
        // Paycrest's `amount` on an amountIn:"fiat" order is the *crypto*
        // figure, so it is the authoritative USDC amount when present.
        ...(order.amount ? { usdcAmount: order.amount } : {}),
        ...(resolvedRate ? { rate: resolvedRate } : {}),
      },
    });
  } catch (error: any) {
    const statusCode =
      typeof error?.status === "number" && error.status >= 400
        ? error.status
        : 500;

    // Paycrest 5xx means their backend/provider is having trouble (e.g. an
    // upstream rail outage on the virtual-account side) rather than anything
    // wrong with this request. Surface a friendly message instead of their
    // raw error, but keep the original in `details` for debugging/support.
    const isUpstreamOutage = statusCode >= 500;
    const userMessage = isUpstreamOutage
      ? "Deposit provisioning is temporarily unavailable. This is an issue on our payment provider's side — please try again in a few minutes."
      : error?.message || "Failed to create onramp order";

    return NextResponse.json(
      {
        error: userMessage,
        details: error?.details ?? null,
      },
      { status: statusCode },
    );
  }
}
