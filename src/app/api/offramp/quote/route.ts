import { NextRequest, NextResponse } from "next/server";
import { PaycrestAdapter } from "@/lib/offramp/adapters/paycrest-adapter";
import { getBurnFeeQuote, computeAtomicFee } from "@/lib/cctp/iris-client";
import { CCTP_DOMAIN, STELLAR_USDC_DECIMALS } from "@/lib/cctp/constants";
import { usdcFloatToStellarInt } from "@/lib/cctp/stellar-cctp";
import {
  validateAmount,
  validateToken,
  validateCurrency,
} from "@/lib/offramp/utils/validation";
import { selectTopProviders } from "@/lib/offramp/provider-routing";

function intToFloat(amountInt: bigint, decimals: number): string {
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = amountInt / divisor;
  const fracDigits = (amountInt % divisor).toString().padStart(decimals, "0");
  const fracTrimmed = fracDigits.replace(/0+$/, "");
  return fracTrimmed ? `${whole}.${fracTrimmed}` : whole.toString();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { amount, token, currency, network, provider_id } = body;

    if (!validateAmount(amount)) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }
    if (!validateToken(token)) {
      return NextResponse.json(
        { error: "Invalid or unsupported token" },
        { status: 400 },
      );
    }
    if (!validateCurrency(currency)) {
      return NextResponse.json(
        { error: "Invalid or unsupported currency" },
        { status: 400 },
      );
    }

    const paycrestApiKey = process.env.PAYCREST_API_KEY;
    if (!paycrestApiKey) {
      throw new Error("PAYCREST_API_KEY not configured");
    }
    const paycrest = new PaycrestAdapter(paycrestApiKey);

    // CCTP burns 1:1 minus a flat fee (no swap spread) — always deducted from
    // the source amount, unlike Allbridge Next's native/stablecoin choice.
    const feeQuote = await getBurnFeeQuote({
      sourceDomain: CCTP_DOMAIN.stellar,
      destDomain: CCTP_DOMAIN.base,
    });
    const amountAtomic = usdcFloatToStellarInt(amount);
    const bridgeFeeFloat = parseFloat(
      intToFloat(
        computeAtomicFee(feeQuote.minimumFeeBps, amountAtomic),
        STELLAR_USDC_DECIMALS,
      ),
    );
    const amountAfterBridge = parseFloat(amount) - bridgeFeeFloat;
    if (amountAfterBridge <= 0) {
      return NextResponse.json(
        { error: "Amount is too small to cover the bridge fee" },
        { status: 400 },
      );
    }
    const receiveAmount = amountAfterBridge.toFixed(6); // Base USDC, 6 decimals

    // Paycrest: convert post-bridge USDC amount to fiat rate/output.
    //
    // Price off the market book so the quoted rate belongs to a provider we would
    // actually route to, and surface the queue we would use. The order route
    // re-derives both against the real order amount — these are informational.
    const resolvedNetwork = (network || "base").toLowerCase();
    let rate: number | undefined;
    let rateSource: "book" | "rates" = "book";
    let providerIds: string[] = [];

    try {
      const book = await paycrest.getMarketBook({
        side: "sell",
        fiat: currency,
        token,
        network: resolvedNetwork,
      });
      const selection = selectTopProviders(book, {
        amount: Number.parseFloat(receiveAmount),
        side: "sell",
        fiat: currency,
        token,
        network: resolvedNetwork,
      });
      if (selection.providerIds.length > 0) {
        rate = selection.rate;
        providerIds = selection.providerIds;
      }
    } catch {
      // Markets is a public, rate-limited endpoint — an outage there must never
      // break quoting. Fall through to /v1/rates below.
    }

    if (rate === undefined) {
      rateSource = "rates";
      rate = await paycrest.getRate(token, receiveAmount, currency, {
        network: resolvedNetwork,
        providerId: provider_id,
      });
    }

    // Platform fee: 0.3%. Paycrest deducts this on their side (it is configured
    // on the account), so this only mirrors the deduction in what we show the
    // user — the order payload deliberately carries no senderFee.
    const grossFiat = amountAfterBridge * rate;
    const platformFeeRate = 0.003;
    const netFiat = grossFiat * (1 - platformFeeRate);

    const sourceAmount = amount;
    const destinationAmount = netFiat.toFixed(2);
    const bridgeFee = (parseFloat(amount) - amountAfterBridge).toString();
    const payoutFee = (grossFiat * platformFeeRate).toFixed(2);

    // CCTP Fast Transfer targets ~8-20s attestation (Circle's published range,
    // not a per-quote estimate — Iris's fee endpoint doesn't return one) + the
    // existing ~2min Paycrest payout buffer.
    const estimatedTime = 30 * 1000 + 2 * 60 * 1000;

    const quoteId = `quote_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return NextResponse.json({
      quoteId,
      sourceAmount,
      destinationAmount,
      bridgeFee,
      payoutFee,
      amountAfterBridge: receiveAmount,
      rate,
      rateSource,
      providerIds,
      estimatedTime,
      validUntil: new Date(Date.now() + 5 * 60 * 1000),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to generate quote" },
      { status: 500 },
    );
  }
}
