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
import {
  MIN_USDC_AMOUNT,
  fiatToUsdc,
  minFiatFor,
  senderFeeFor,
  solveUsdcForFiat,
  usdcToFiat,
} from "@/lib/offramp/fiat-conversion";
import type { MarketOffer } from "@/lib/offramp/types";
import { withRetry, isNetworkFetchError } from "@/lib/cctp/retry";

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
    // "fiat" means `amount` is the figure the recipient should be credited, and
    // the USDC to burn is derived from it.
    const amountIn =
      String(body?.amountIn ?? "crypto").toLowerCase() === "fiat"
        ? "fiat"
        : "crypto";

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

    // Everything below is read-only (rate/book lookups, a fee quote) — no
    // order is created — so retrying the whole sequence once on a transient
    // network blip (Paycrest or Circle's Iris API) is always safe. A plain
    // 400/404-style NextResponse returned from inside here just resolves
    // normally and is never retried — withRetry only reacts to a thrown
    // error, which a raw fetch-level failure (DNS, connection reset) is.
    return await withRetry(async (): Promise<NextResponse> => {
      // Which corridors exist is Paycrest's to answer, not ours to hardcode.
      // Unreachable lookup falls back to a static list rather than blocking.
      const fiatCode = String(currency).toUpperCase();
      if (!(await paycrest.isSupportedCurrency(fiatCode))) {
        return NextResponse.json(
          { error: `Currency ${fiatCode} is not supported` },
          { status: 400 },
        );
      }

      const resolvedNetwork = (network || "base").toLowerCase();

      // CCTP burns 1:1 minus a proportional fee (no swap spread) — always
      // deducted from the source amount.
      const feeQuote = await getBurnFeeQuote({
        sourceDomain: CCTP_DOMAIN.stellar,
        destDomain: CCTP_DOMAIN.base,
      });
      const bridgeBps = feeQuote.minimumFeeBps;

      // One book fetch serves both the rate and, in fiat mode, the reverse solve.
      let book: MarketOffer[] = [];
      try {
        book = await paycrest.getMarketBook({
          side: "sell",
          fiat: fiatCode,
          token,
          network: resolvedNetwork,
        });
      } catch {
        // Markets is public and rate-limited — an outage there must never break
        // quoting. Everything below falls back to /v1/rates.
      }

      /**
       * Rate the book would give for a burn of `usdcPreBridge`.
       *
       * Bands are matched against what Paycrest actually receives, so the bridge
       * fee has to come off before selecting — otherwise an amount near a band
       * edge picks the wrong tier.
       */
      const resolveRate = (usdcPreBridge: number): number => {
        if (book.length === 0) return 0;
        const afterBridge = usdcPreBridge * (1 - (bridgeBps || 0) / 10_000);
        return selectTopProviders(book, {
          amount: afterBridge,
          side: "sell",
          fiat: fiatCode,
          token,
          network: resolvedNetwork,
        }).rate;
      };

      // The corridor's floor, expressed in fiat, for the client to enforce.
      const seedRate = resolveRate(MIN_USDC_AMOUNT);
      const minFiat = seedRate > 0 ? minFiatFor(fiatCode, seedRate, bridgeBps) : 0;

      // Resolve the USDC to burn. In crypto mode that is what the user typed; in
      // fiat mode it is solved for, because the rate depends on the amount.
      let sourceUsdc: number;
      if (amountIn === "fiat") {
        const targetFiat = Number.parseFloat(String(amount));
        const solved = solveUsdcForFiat(targetFiat, { resolveRate, bridgeBps });
        if (solved.usdc > 0) {
          sourceUsdc = solved.usdc;
        } else {
          // No book. Seed off /v1/rates at the corridor floor — close enough to
          // quote, and the forward pass below re-prices it honestly.
          const fallbackRate = await paycrest.getRate(
            token,
            MIN_USDC_AMOUNT.toFixed(6),
            fiatCode,
            { network: resolvedNetwork, providerId: provider_id },
          );
          sourceUsdc = fiatToUsdc(targetFiat, fallbackRate, bridgeBps);
        }
        if (!Number.isFinite(sourceUsdc) || sourceUsdc <= 0) {
          return NextResponse.json(
            { error: "Could not derive a USDC amount for that payout" },
            { status: 400 },
          );
        }
      } else {
        sourceUsdc = Number.parseFloat(String(amount));
      }

      // Below the corridor floor there is no provider band to price against, and
      // asking Paycrest anyway returns "no provider available" as a 500. That is
      // the common case while someone is still typing — every keystroke of
      // "15000" passes through 1, 15 and 150 — so answer it directly, cheaply,
      // and with the minimum attached so the client can show it.
      if (sourceUsdc < MIN_USDC_AMOUNT) {
        return NextResponse.json(
          {
            code: "BELOW_MINIMUM",
            error:
              amountIn === "fiat" && minFiat > 0
                ? `Minimum is ${minFiat.toLocaleString("en-US")} ${fiatCode}`
                : `Minimum is ${MIN_USDC_AMOUNT} USDC`,
            minFiat,
            minUsdc: MIN_USDC_AMOUNT,
          },
          { status: 400 },
        );
      }

      const sourceAmount = sourceUsdc.toFixed(6);

      // --- Forward path. Authoritative in both modes: whatever the reverse solve
      // estimated, the figure shown to the user comes from re-pricing the
      // resolved USDC against the book.
      const amountAtomic = usdcFloatToStellarInt(sourceAmount);
      const bridgeFeeFloat = parseFloat(
        intToFloat(
          computeAtomicFee(bridgeBps, amountAtomic),
          STELLAR_USDC_DECIMALS,
        ),
      );
      const amountAfterBridge = sourceUsdc - bridgeFeeFloat;
      if (amountAfterBridge <= 0) {
        return NextResponse.json(
          { error: "Amount is too small to cover the bridge fee" },
          { status: 400 },
        );
      }
      const receiveAmount = amountAfterBridge.toFixed(6); // Base USDC, 6 decimals

      // Price off the market book so the quoted rate belongs to a provider we
      // would actually route to, and surface the queue we would use. The order
      // route re-derives both against the real order amount — these are
      // informational.
      let rate: number | undefined;
      let rateSource: "book" | "rates" = "book";
      let providerIds: string[] = [];

      if (book.length > 0) {
        const selection = selectTopProviders(book, {
          amount: Number.parseFloat(receiveAmount),
          side: "sell",
          fiat: fiatCode,
          token,
          network: resolvedNetwork,
        });
        if (selection.providerIds.length > 0) {
          rate = selection.rate;
          providerIds = selection.providerIds;
        }
      }

      if (rate === undefined) {
        rateSource = "rates";
        rate = await paycrest.getRate(token, receiveAmount, fiatCode, {
          network: resolvedNetwork,
          providerId: provider_id,
        });
      }

      // Platform fee: 0.3%, deducted by Paycrest from the account config — the
      // order payload deliberately carries no senderFee. Modelled with their 4dp
      // rounding (assumed upward) so the quoted figure is never above what the
      // recipient actually receives.
      const feeUsdc = senderFeeFor(amountAfterBridge);
      const netFiat = usdcToFiat(sourceUsdc, rate, bridgeBps);

      const destinationAmount = netFiat.toFixed(2);
      const bridgeFee = (sourceUsdc - amountAfterBridge).toString();
      const payoutFee = (feeUsdc * rate).toFixed(2);

      // CCTP Fast Transfer targets ~8-20s attestation (Circle's published range,
      // not a per-quote estimate — Iris's fee endpoint doesn't return one) + the
      // existing ~2min Paycrest payout buffer.
      const estimatedTime = 30 * 1000 + 2 * 60 * 1000;

      const quoteId = `quote_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      return NextResponse.json({
        quoteId,
        amountIn,
        sourceAmount,
        destinationAmount,
        bridgeFee,
        payoutFee,
        amountAfterBridge: receiveAmount,
        rate,
        rateSource,
        providerIds,
        minFiat,
        minUsdc: MIN_USDC_AMOUNT,
        bridgeBps,
        estimatedTime,
        validUntil: new Date(Date.now() + 5 * 60 * 1000),
      });
    });
  } catch (error: any) {
    const userMessage = isNetworkFetchError(error)
      ? "Couldn't reach the pricing service right now. Please try again in a moment."
      : error.message || "Failed to generate quote";
    return NextResponse.json({ error: userMessage }, { status: 500 });
  }
}
