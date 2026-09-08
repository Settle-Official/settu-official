import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, formatEther } from "viem";
import {
  EVM_SOURCE_CHAINS,
  EVM_CCTP_TOKEN_MESSENGER_V2,
  isCctpBridgeChain,
  isChainEnabled,
  type EvmChainKey,
} from "@/lib/cctp/evm-chains";
import { buildEvmBurnCalldata, usdcFloatToEvmInt } from "@/lib/cctp/evm-burn";
import { getBurnFeeQuote, computeAtomicFee } from "@/lib/cctp/iris-client";
import { CCTP_DOMAIN } from "@/lib/cctp/constants";
import { withRetry, isNetworkFetchError } from "@/lib/cctp/retry";
import { validateAmount, validateAddress } from "@/lib/offramp/utils/validation";

const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { amount, fromAddress, toAddress, sourceChain } = body;

    if (!validateAmount(amount)) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }
    if (!validateAddress(fromAddress, "base")) {
      return NextResponse.json({ error: "Invalid source wallet address" }, { status: 400 });
    }
    if (!validateAddress(toAddress, "base")) {
      return NextResponse.json({ error: "Invalid Paycrest receive address" }, { status: 400 });
    }
    const chainConfig = EVM_SOURCE_CHAINS[sourceChain as EvmChainKey];
    if (!chainConfig || !isCctpBridgeChain(chainConfig)) {
      return NextResponse.json(
        { error: `${sourceChain} is not a supported CCTP-bridge source chain` },
        { status: 400 },
      );
    }
    if (!isChainEnabled(chainConfig.key)) {
      return NextResponse.json(
        { error: `${chainConfig.label} is not currently enabled as a source chain` },
        { status: 400 },
      );
    }

    const rpcUrl = process.env[chainConfig.rpcUrlEnvVar];
    if (!rpcUrl) {
      throw new Error(`${chainConfig.rpcUrlEnvVar} not configured`);
    }

    // Everything below is read-only (an RPC allowance read + a fee quote) —
    // no broadcast, so retrying the whole sequence once on a transient
    // network blip is always safe. Mirrors offramp/bridge/build-tx.
    const result = await withRetry(async () => {
      const publicClient = createPublicClient({ transport: http(rpcUrl) });

      const allowance = await publicClient.readContract({
        address: chainConfig.usdcAddress,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: "allowance",
        args: [fromAddress, EVM_CCTP_TOKEN_MESSENGER_V2],
      });

      const feeQuote = await getBurnFeeQuote({
        sourceDomain: chainConfig.cctpDomain,
        destDomain: CCTP_DOMAIN.base,
      });
      const amountAtomic = usdcFloatToEvmInt(amount);
      const maxFeeAtomic = computeAtomicFee(feeQuote.minimumFeeBps, amountAtomic);

      const calls = buildEvmBurnCalldata({
        chain: chainConfig,
        amountFloat: amount,
        mintRecipient: toAddress,
        maxFeeAtomic,
        currentAllowance: allowance,
      });

      // Best-effort gas estimate for the pre-flight "do you have enough native
      // token" check and display. The first call is always estimable (an
      // approve, or the burn itself when allowance already covers it); a
      // second call is the burn-after-approve, which can't be estimated
      // before the approve lands, so add a conservative fixed allowance for
      // it. +20% buffer — the wallet's own gas price at signing is
      // authoritative, this is only advisory.
      let estimatedGasNative: string | null = null;
      try {
        const firstGas = await publicClient.estimateGas({
          account: fromAddress,
          to: calls[0].to,
          data: calls[0].data,
        });
        const totalGas = calls.length > 1 ? firstGas + BigInt(250_000) : firstGas;
        const gasPrice = await publicClient.getGasPrice();
        estimatedGasNative = formatEther(
          (totalGas * gasPrice * BigInt(120)) / BigInt(100),
        );
      } catch {
        // Estimation is advisory — never fail tx-building over it.
      }

      return {
        calls,
        chainId: chainConfig.chainId,
        estimatedGasNative,
        nativeCurrencySymbol: chainConfig.nativeCurrencySymbol,
      };
    });

    return NextResponse.json(result);
  } catch (error: any) {
    const msg = error.message || "";
    const userMessage = isNetworkFetchError(error)
      ? "Couldn't reach the blockchain network right now. Please try again in a moment."
      : msg || "Failed to build transaction";
    return NextResponse.json({ error: userMessage }, { status: 500 });
  }
}
