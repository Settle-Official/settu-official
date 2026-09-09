import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, formatEther, encodeFunctionData } from "viem";
import {
  EVM_SOURCE_CHAINS,
  EVM_CCTP_TOKEN_MESSENGER_V2,
  isCctpBridgeChain,
  isChainEnabled,
  type EvmChainKey,
} from "@/lib/cctp/evm-chains";
import { usdcFloatToEvmInt } from "@/lib/cctp/evm-burn";
import { withRetry, isNetworkFetchError } from "@/lib/cctp/retry";
import { validateAddress } from "@/lib/offramp/utils/validation";

export const maxDuration = 30;

const ERC20_MIN_ABI = [
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
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// Conservative fixed allowance for a depositForBurn we can't estimate yet
// (the approve hasn't landed, so a real estimate would revert). CCTP V2
// depositForBurn is ~150-190k gas in practice; 250k leaves headroom.
const BURN_GAS_FALLBACK = BigInt(250_000);
const GAS_BUFFER_NUM = BigInt(120); // +20%
const GAS_BUFFER_DEN = BigInt(100);

/**
 * Pre-flight for an EVM-source offramp: does this wallet hold enough of the
 * chain's native token to pay gas for the burn/transfer it's about to sign?
 * Read-only — mirrors evm-build-tx's pattern (server RPC, withRetry). The
 * amount is optional and only sharpens the estimate; the real gas price at
 * signing time is authoritative, this is a "will it obviously fail" gate.
 */
export async function GET(request: NextRequest) {
  try {
    const address = request.nextUrl.searchParams.get("address") || "";
    const chain = request.nextUrl.searchParams.get("chain") || "";
    const amount = request.nextUrl.searchParams.get("amount") || "1";

    if (!validateAddress(address, "base")) {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }
    const chainConfig = EVM_SOURCE_CHAINS[chain as EvmChainKey];
    if (!chainConfig) {
      return NextResponse.json({ error: `Unknown source chain: ${chain}` }, { status: 400 });
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

    const result = await withRetry(async () => {
      const publicClient = createPublicClient({ transport: http(rpcUrl) });
      const owner = address as `0x${string}`;
      const amountAtomic = usdcFloatToEvmInt(amount);

      const [balanceWei, gasPrice] = await Promise.all([
        publicClient.getBalance({ address: owner }),
        publicClient.getGasPrice(),
      ]);

      let gasUnits: bigint;
      if (isCctpBridgeChain(chainConfig)) {
        const allowance = await publicClient.readContract({
          address: chainConfig.usdcAddress,
          abi: ERC20_MIN_ABI,
          functionName: "allowance",
          args: [owner, EVM_CCTP_TOKEN_MESSENGER_V2],
        });
        // Estimate the approve (always valid), then add a burn allowance —
        // once allowance already covers it, only the burn fallback is needed.
        if (allowance < amountAtomic) {
          const approveGas = await publicClient.estimateGas({
            account: owner,
            to: chainConfig.usdcAddress,
            data: encodeFunctionData({
              abi: ERC20_MIN_ABI,
              functionName: "approve",
              args: [EVM_CCTP_TOKEN_MESSENGER_V2, amountAtomic],
            }),
          });
          gasUnits = approveGas + BURN_GAS_FALLBACK;
        } else {
          gasUnits = BURN_GAS_FALLBACK;
        }
      } else {
        // Base direct transfer — estimable directly against the user's own
        // address as a stand-in recipient.
        gasUnits = await publicClient.estimateGas({
          account: owner,
          to: chainConfig.usdcAddress,
          data: encodeFunctionData({
            abi: ERC20_MIN_ABI,
            functionName: "transfer",
            args: [owner, amountAtomic],
          }),
        });
      }

      const estimatedWei = (gasUnits * gasPrice * GAS_BUFFER_NUM) / GAS_BUFFER_DEN;
      return {
        nativeBalance: formatEther(balanceWei),
        estimatedGasNative: formatEther(estimatedWei),
        nativeCurrencySymbol: chainConfig.nativeCurrencySymbol,
        sufficient: balanceWei >= estimatedWei,
      };
    });

    return NextResponse.json(result);
  } catch (error: any) {
    const msg = error?.message || "";
    const userMessage = isNetworkFetchError(error)
      ? "Couldn't reach the blockchain network right now. Please try again in a moment."
      : msg || "Failed to check gas balance";
    return NextResponse.json({ error: userMessage }, { status: 500 });
  }
}
