import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, formatUnits, formatEther } from "viem";
import {
  EVM_SOURCE_CHAINS,
  isChainEnabled,
  type EvmChainKey,
} from "@/lib/cctp/evm-chains";
import { withRetry, isNetworkFetchError } from "@/lib/cctp/retry";
import { validateAddress } from "@/lib/offramp/utils/validation";

export const maxDuration = 20;

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const EVM_USDC_DECIMALS = 6;

/**
 * The connected EVM wallet's USDC + native-token balances on one source
 * chain, for the header readout and FormCard's balance check. Read-only,
 * server RPC — mirrors evm-build-tx / evm-gas-preflight.
 */
export async function GET(request: NextRequest) {
  try {
    const address = request.nextUrl.searchParams.get("address") || "";
    const chain = request.nextUrl.searchParams.get("chain") || "";

    if (!validateAddress(address, "base")) {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }
    const chainConfig = EVM_SOURCE_CHAINS[chain as EvmChainKey];
    if (!chainConfig) {
      return NextResponse.json({ error: `Unknown source chain: ${chain}` }, { status: 400 });
    }
    if (!isChainEnabled(chainConfig.key)) {
      return NextResponse.json(
        { error: `${chainConfig.label} is not currently enabled` },
        { status: 400 },
      );
    }

    const rpcUrl = process.env[chainConfig.rpcUrlEnvVar];
    if (!rpcUrl) throw new Error(`${chainConfig.rpcUrlEnvVar} not configured`);

    const result = await withRetry(async () => {
      const publicClient = createPublicClient({ transport: http(rpcUrl) });
      const owner = address as `0x${string}`;

      const [usdcRaw, nativeRaw] = await Promise.all([
        publicClient.readContract({
          address: chainConfig.usdcAddress,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [owner],
        }),
        publicClient.getBalance({ address: owner }),
      ]);

      return {
        usdc: formatUnits(usdcRaw, EVM_USDC_DECIMALS),
        native: formatEther(nativeRaw),
        nativeSymbol: chainConfig.nativeCurrencySymbol,
      };
    });

    return NextResponse.json(result);
  } catch (error: any) {
    const msg = error?.message || "";
    const userMessage = isNetworkFetchError(error)
      ? "Couldn't reach the blockchain network right now."
      : msg || "Failed to fetch balances";
    return NextResponse.json({ error: userMessage }, { status: 500 });
  }
}
