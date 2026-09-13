import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  encodeFunctionData,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import {
  CCTP_CONFIG,
  CCTP_DOMAIN,
  CCTP_NETWORK,
  FINALITY_THRESHOLD,
  BASE_USDC_DECIMALS,
} from "./constants";
import {
  contractStrkeyToBytes32Hex,
  buildForwarderHookData,
} from "./address-encoding";

export class CctpBaseGasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CctpBaseGasError";
  }
}

export function usdcFloatToBaseInt(amount: string): bigint {
  const [intPart, fracPart = ""] = amount.split(".");
  const frac = fracPart.padEnd(BASE_USDC_DECIMALS, "0").slice(0, BASE_USDC_DECIMALS);
  return (
    BigInt(intPart || "0") * BigInt(10) ** BigInt(BASE_USDC_DECIMALS) + BigInt(frac || "0")
  );
}

function getAccount() {
  const pk = process.env.ONRAMP_HOT_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error("ONRAMP_HOT_WALLET_PRIVATE_KEY not configured");
  const normalized = (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;
  return privateKeyToAccount(normalized);
}

function getClients() {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("BASE_RPC_URL not configured");
  const account = getAccount();
  const chain = CCTP_NETWORK === "testnet" ? baseSepolia : base;
  const transport = http(rpcUrl);
  return {
    account,
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ account, chain, transport }),
  };
}

async function assertBaseGasFloor(publicClient: ReturnType<typeof getClients>["publicClient"], address: Hex) {
  const floor = parseEther(process.env.ONRAMP_MIN_GAS_ETH || "0.0005");
  const balance = await publicClient.getBalance({ address });
  if (balance < floor) {
    throw new CctpBaseGasError(
      `Base hot wallet ETH balance ${balance} below floor ${floor}; refusing to submit`,
    );
  }
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

const DEPOSIT_FOR_BURN_WITH_HOOK_ABI = [
  {
    type: "function",
    name: "depositForBurnWithHook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const RECEIVE_MESSAGE_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const ALLOWANCE_ABI = [
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

/**
 * Blocks until the approval is visible, because a confirmed receipt only
 * proves one node applied it. Broadcasting the burn before the node serving
 * eth_estimateGas catches up makes viem throw on a simulated revert.
 */
async function waitForAllowance(
  publicClient: ReturnType<typeof getClients>["publicClient"],
  owner: `0x${string}`,
  amount: bigint,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const seen = await publicClient
      .readContract({
        address: CCTP_CONFIG.baseUsdc,
        abi: ALLOWANCE_ABI,
        functionName: "allowance",
        args: [owner, CCTP_CONFIG.baseTokenMessengerV2],
      })
      .catch(() => BigInt(0));
    if (seen >= amount) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    "Approval confirmed on-chain but not yet visible to the RPC pool — the burn was not attempted.",
  );
}

/**
 * Onramp burn: Base source, Stellar destination. Always uses the CctpForwarder
 * hook pattern — TokenMessengerMinter treats `mintRecipient` as a contract on
 * Stellar, so `mintRecipient` and `destinationCaller` are BOTH the Stellar
 * CctpForwarder, with the real user's G-address carried in hookData. Getting
 * mintRecipient/destinationCaller wrong here permanently strands funds
 * (per Circle's own docs warning) — do not "simplify" this away.
 */
export async function submitBaseBurnWithHook(params: {
  amountFloat: string;
  forwardRecipientStrkey: string; // real Stellar user address
  maxFeeBaseInt: bigint;
  fast?: boolean;
}): Promise<string> {
  const { account, publicClient, walletClient } = getClients();
  await assertBaseGasFloor(publicClient, account.address);

  const amount = usdcFloatToBaseInt(params.amountFloat);
  const forwarderBytes32 = contractStrkeyToBytes32Hex(CCTP_CONFIG.stellarCctpForwarder);
  const hookData = buildForwarderHookData(params.forwardRecipientStrkey);

  // Approve if needed (mirrors base-bridge.ts's existing allowance-check pattern).
  const allowance = await publicClient.readContract({
    address: CCTP_CONFIG.baseUsdc,
    abi: [
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
    ] as const,
    functionName: "allowance",
    args: [account.address, CCTP_CONFIG.baseTokenMessengerV2],
  });
  if (allowance < amount) {
    const approveTx = await walletClient.sendTransaction({
      to: CCTP_CONFIG.baseUsdc,
      data: encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [CCTP_CONFIG.baseTokenMessengerV2, amount],
      }),
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    await waitForAllowance(publicClient, account.address, amount);
  }

  const burnTx = await walletClient.sendTransaction({
    to: CCTP_CONFIG.baseTokenMessengerV2,
    data: encodeFunctionData({
      abi: DEPOSIT_FOR_BURN_WITH_HOOK_ABI,
      functionName: "depositForBurnWithHook",
      args: [
        amount,
        CCTP_DOMAIN.stellar,
        forwarderBytes32,
        CCTP_CONFIG.baseUsdc,
        forwarderBytes32, // destinationCaller = same forwarder
        params.maxFeeBaseInt,
        params.fast === false ? FINALITY_THRESHOLD.standard : FINALITY_THRESHOLD.fast,
        hookData,
      ],
    }),
  });
  await publicClient.waitForTransactionReceipt({ hash: burnTx });
  return burnTx;
}

/**
 * Offramp mint: submits `receiveMessage` on Base's MessageTransmitterV2, gas
 * paid by our Base hot wallet. Permissionless — mints straight to whatever
 * mintRecipient was encoded at burn time (Paycrest's settlementAddress), not
 * to our wallet.
 */
export async function submitBaseMint(params: {
  messageHex: string;
  attestationHex: string;
}): Promise<string> {
  const { account, publicClient, walletClient } = getClients();
  await assertBaseGasFloor(publicClient, account.address);

  const tx = await walletClient.sendTransaction({
    to: CCTP_CONFIG.baseMessageTransmitterV2,
    data: encodeFunctionData({
      abi: RECEIVE_MESSAGE_ABI,
      functionName: "receiveMessage",
      args: [params.messageHex as Hex, params.attestationHex as Hex],
    }),
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  return tx;
}
