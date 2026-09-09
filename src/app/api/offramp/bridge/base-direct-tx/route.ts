import { NextRequest, NextResponse } from "next/server";
import { encodeFunctionData } from "viem";
import { EVM_SOURCE_CHAINS, isChainEnabled } from "@/lib/cctp/evm-chains";
import { usdcFloatToEvmInt } from "@/lib/cctp/evm-burn";
import { validateAmount, validateAddress } from "@/lib/offramp/utils/validation";

const ERC20_TRANSFER_ABI = [
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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { amount, toAddress } = body;

    if (!validateAmount(amount)) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }
    if (!validateAddress(toAddress, "base")) {
      return NextResponse.json({ error: "Invalid Paycrest receive address" }, { status: 400 });
    }
    if (!isChainEnabled("base")) {
      return NextResponse.json(
        { error: "Base is not currently enabled as a source chain" },
        { status: 400 },
      );
    }

    const base = EVM_SOURCE_CHAINS.base;
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [toAddress, usdcFloatToEvmInt(amount)],
    });

    return NextResponse.json({
      to: base.usdcAddress,
      data,
      chainId: base.chainId,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to build transfer" },
      { status: 500 },
    );
  }
}
