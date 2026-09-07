import { NextRequest, NextResponse } from "next/server";
import { PaycrestAdapter } from "@/lib/offramp/adapters/paycrest-adapter";
import { getBurnFeeQuote, computeAtomicFee } from "@/lib/cctp/iris-client";
import { CCTP_DOMAIN, STELLAR_USDC_DECIMALS } from "@/lib/cctp/constants";
import { usdcFloatToStellarInt } from "@/lib/cctp/stellar-cctp";
import {
  PAYCREST_SENDER_FEE_RATE,
  applyPaycrestSenderFee,
  invertPaycrestSenderFee,
} from "@/lib/offramp/fee";
import {
  validateAmount,
  validateToken,
  validateCurrency,
} from "@/lib/offramp/utils/validation";

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
    const { amount, token, currency, network, provider_id, amountType } = body;
    // "fiat": `amount` is the NET fiat the recipient should end up with —
    // work backwards to find the USDC the sender needs to burn. "crypto"
    // (default, and the only mode before this) is the existing direction:
    // `amount` is USDC, find what the recipient receives.
    const isFiatInput = amountType === "fiat";

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
    const bridgeFeeFraction = feeQuote.minimumFeeBps / 10_000;

    // Paycrest's rate is amount-invariant (confirmed live: quoting the same
    // pair at 1, 10, and 5000 USDC all returned the identical rate), so it's
    // always safe to fetch with a nominal probe amount — including in fiat
    // mode, before we even know the real USDC figure yet.
    const rate = await paycrest.getRate(token, "1", currency, {
      network: network || "base",
      providerId: provider_id,
    });

    // usdcAmount is the actual amount that will get burned on Stellar —
    // everything below this point works forward from it exactly the same
    // way regardless of which unit the caller typed in.
    let usdcAmount: number;

    if (isFiatInput) {
      const desiredNetFiat = parseFloat(amount);
      const grossFiat = invertPaycrestSenderFee(desiredNetFiat);
      const amountAfterBridge = grossFiat / rate;
      // Invert the bridge-fee deduction too: amountAfterBridge =
      // usdcAmount * (1 - bridgeFeeFraction), currently a no-op since
      // Stellar->Base's fee is 0 bps, but this direction should still hold
      // if that ever changes.
      const rawUsdcAmount = amountAfterBridge / (1 - bridgeFeeFraction);
      // Round UP at Stellar's 7-decimal precision (never down) — this is a
      // "the recipient gets AT LEAST what they asked for" guarantee, not a
      // best-effort estimate, so any sub-cent rounding must favor the user.
      usdcAmount = Math.ceil(rawUsdcAmount * 1e7) / 1e7;
    } else {
      usdcAmount = parseFloat(amount);
    }

    if (!validateAmount(usdcAmount.toFixed(7))) {
      return NextResponse.json(
        { error: "Amount is too small" },
        { status: 400 },
      );
    }

    const amountAtomic = usdcFloatToStellarInt(usdcAmount.toFixed(7));
    const bridgeFeeFloat = parseFloat(
      intToFloat(
        computeAtomicFee(feeQuote.minimumFeeBps, amountAtomic),
        STELLAR_USDC_DECIMALS,
      ),
    );
    const amountAfterBridge = usdcAmount - bridgeFeeFloat;
    if (amountAfterBridge <= 0) {
      return NextResponse.json(
        { error: "Amount is too small to cover the bridge fee" },
        { status: 400 },
      );
    }
    const receiveAmount = amountAfterBridge.toFixed(6); // Base USDC, 6 decimals

    // Paycrest's own sender fee (configured on their dashboard) is deducted
    // automatically from whatever gross amount we send them — this mirrors
    // that exact math so the estimate shown here matches what actually gets
    // paid out, instead of guessing at a separate, unrelated percentage.
    const grossFiat = amountAfterBridge * rate;
    const netFiat = applyPaycrestSenderFee(grossFiat);

    const sourceAmount = usdcAmount.toFixed(6);
    // In fiat mode, report back exactly what the user asked to receive
    // rather than the forward-recomputed figure — they're mathematically
    // the same up to sub-cent rounding, but echoing the literal input avoids
    // ever showing the user a number that doesn't match what they typed.
    const destinationAmount = isFiatInput
      ? parseFloat(amount).toFixed(2)
      : netFiat.toFixed(2);
    const bridgeFee = (usdcAmount - amountAfterBridge).toString();
    const payoutFee = (grossFiat * PAYCREST_SENDER_FEE_RATE).toFixed(2);

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
