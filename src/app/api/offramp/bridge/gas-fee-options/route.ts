import { NextRequest, NextResponse } from "next/server";
import { getBurnFeeQuote, computeAtomicFee } from "@/lib/cctp/iris-client";
import { withRetry } from "@/lib/cctp/retry";
import { CCTP_DOMAIN, STELLAR_USDC_DECIMALS } from "@/lib/cctp/constants";
import { usdcFloatToStellarInt } from "@/lib/cctp/stellar-cctp";
import { usdcFloatToEvmInt } from "@/lib/cctp/evm-burn";
import {
  EVM_SOURCE_CHAINS,
  isCctpBridgeChain,
  type EvmChainKey,
} from "@/lib/cctp/evm-chains";
import {
  SOLANA_CCTP_DOMAIN,
  SOLANA_USDC_DECIMALS,
  usdcFloatToSolanaAtomic,
} from "@/lib/solana/config";

const EVM_USDC_DECIMALS = 6;

function intToFloat(amountInt: bigint, decimals: number): string {
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = amountInt / divisor;
  const fracDigits = (amountInt % divisor).toString().padStart(decimals, "0");
  const fracTrimmed = fracDigits.replace(/0+$/, "");
  return fracTrimmed ? `${whole}.${fracTrimmed}` : whole.toString();
}

const ZERO_FEE = { fee: { int: "0", float: "0" } };

export async function GET(request: NextRequest) {
  try {
    const amountParam = request.nextUrl.searchParams.get("amount");
    const sourceChain = request.nextUrl.searchParams.get("sourceChain") || "stellar";

    // Base as a source uses a plain USDC transfer, not CCTP — there is no
    // bridge fee at all.
    if (sourceChain === "base") {
      return NextResponse.json({ feeOptions: ZERO_FEE });
    }

    // Resolve the CCTP source domain + the source token's decimals. Stellar
    // (the default, and the only thing the pre-change client sends) keeps its
    // exact previous behaviour.
    let sourceDomain: number = CCTP_DOMAIN.stellar;
    let decimals: number = STELLAR_USDC_DECIMALS;
    let toAtomic: (amount: string) => bigint = usdcFloatToStellarInt;
    if (sourceChain === "solana") {
      sourceDomain = SOLANA_CCTP_DOMAIN;
      decimals = SOLANA_USDC_DECIMALS;
      toAtomic = usdcFloatToSolanaAtomic;
    } else if (sourceChain !== "stellar") {
      const chainConfig = EVM_SOURCE_CHAINS[sourceChain as EvmChainKey];
      if (!chainConfig || !isCctpBridgeChain(chainConfig)) {
        return NextResponse.json(
          { error: `${sourceChain} is not a supported CCTP-bridge source chain` },
          { status: 400 },
        );
      }
      sourceDomain = chainConfig.cctpDomain;
      decimals = EVM_USDC_DECIMALS;
      toAtomic = usdcFloatToEvmInt;
    }

    // A read-only fee quote — retry once on a transient network blip reaching
    // Circle's Iris API, matching offramp/bridge/quote's existing fix.
    const quote = await withRetry(() =>
      getBurnFeeQuote({
        sourceDomain,
        destDomain: CCTP_DOMAIN.base,
      }),
    );
    // The fee is a bps rate of the burn amount, not a flat charge — with no
    // amount given (e.g. the pre-form-fill preview fetch) there's nothing to
    // apply it to, so report zero rather than a meaningless atomic value.
    const amountAtomic =
      amountParam && parseFloat(amountParam) > 0
        ? toAtomic(amountParam)
        : BigInt(0);
    const feeAtomic = computeAtomicFee(quote.minimumFeeBps, amountAtomic);
    return NextResponse.json({
      feeOptions: {
        fee: {
          int: feeAtomic.toString(),
          float: intToFloat(feeAtomic, decimals),
        },
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to fetch gas fee options" },
      { status: 500 },
    );
  }
}
