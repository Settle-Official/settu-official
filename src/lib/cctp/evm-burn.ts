import { encodeFunctionData, type Hex } from "viem";
import {
  EVM_CCTP_TOKEN_MESSENGER_V2,
  isCctpBridgeChain,
  type SourceChainConfig,
} from "./evm-chains";
import { CCTP_DOMAIN, FINALITY_THRESHOLD } from "./constants";

const EVM_USDC_DECIMALS = 6; // identical across every EVM chain's native USDC

export function usdcFloatToEvmInt(amount: string): bigint {
  const [intPart, fracPart = ""] = amount.split(".");
  const frac = fracPart.padEnd(EVM_USDC_DECIMALS, "0").slice(0, EVM_USDC_DECIMALS);
  return (
    BigInt(intPart || "0") * BigInt(10) ** BigInt(EVM_USDC_DECIMALS) + BigInt(frac || "0")
  );
}

const ERC20_APPROVE_ABI = [
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
] as const;

const DEPOSIT_FOR_BURN_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
] as const;

function addressToBytes32(address: `0x${string}`): Hex {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/**
 * Builds the ordered list of unsigned calls (approve, if needed, then
 * depositForBurn) for a user's own wallet to sign to burn USDC on `chain`
 * for offramp. Unlike onramp's Base->Stellar leg, this needs no forwarder
 * hook -- the destination is Base directly (Paycrest's receive address),
 * not routed through Stellar's CctpForwarder -- so this calls
 * depositForBurn, not depositForBurnWithHook, and destinationCaller is
 * left as the zero address (no restriction on who submits the mint).
 */
export function buildEvmBurnCalldata(params: {
  chain: SourceChainConfig;
  amountFloat: string;
  mintRecipient: `0x${string}`; // Paycrest's Base receive address for this order
  maxFeeAtomic: bigint;
  currentAllowance: bigint;
  fast?: boolean;
}): { to: `0x${string}`; data: `0x${string}` }[] {
  if (!isCctpBridgeChain(params.chain)) {
    throw new Error(
      `buildEvmBurnCalldata called for a non-CCTP-bridge chain: ${params.chain.key}`,
    );
  }

  const amount = usdcFloatToEvmInt(params.amountFloat);
  const calls: { to: `0x${string}`; data: `0x${string}` }[] = [];

  if (params.currentAllowance < amount) {
    calls.push({
      to: params.chain.usdcAddress,
      data: encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [EVM_CCTP_TOKEN_MESSENGER_V2, amount],
      }),
    });
  }

  calls.push({
    to: EVM_CCTP_TOKEN_MESSENGER_V2,
    data: encodeFunctionData({
      abi: DEPOSIT_FOR_BURN_ABI,
      functionName: "depositForBurn",
      args: [
        amount,
        CCTP_DOMAIN.base,
        addressToBytes32(params.mintRecipient),
        params.chain.usdcAddress,
        addressToBytes32("0x0000000000000000000000000000000000000000"),
        params.maxFeeAtomic,
        params.fast === false ? FINALITY_THRESHOLD.standard : FINALITY_THRESHOLD.fast,
      ],
    }),
  });

  return calls;
}
