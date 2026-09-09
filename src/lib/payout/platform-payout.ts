// Platform-funded payout: creates a Paycrest order and pays it from our own
// Base wallet. Unlike a user offramp, no user-signed transfer funds this, so
// every guard here is the only thing standing between a caller and our float.
//
// Extracted from the unreachable /api/offramp/execute-payout route, with its
// holes closed: that version took the rate from the request body (an arbitrary
// -payout hole), trusted a client-supplied account name, never checked balances
// before creating an order, and could not tell a pre-broadcast failure from a
// post-broadcast one.

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  parseEther,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { PaycrestAdapter } from "@/lib/offramp/adapters/paycrest-adapter";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const USDC_DECIMALS = 6;

const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// Nothing was broadcast — the caller may safely refund and retry.
export class PayoutPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutPreflightError";
  }
}

// A transfer is on-chain but unconfirmed. Never auto-refund or retry on this.
export class PayoutBroadcastError extends Error {
  constructor(
    message: string,
    readonly txHash: string,
    readonly paycrestOrderId?: string,
  ) {
    super(message);
    this.name = "PayoutBroadcastError";
  }
}

export interface PlatformPayoutParams {
  amountUsdc: number;
  currency: string;
  /** Must already be verified against the bank — never pass client-supplied names. */
  recipient: {
    institution: string;
    accountIdentifier: string;
    accountName: string;
  };
  memo?: string;
  providerId?: string;
}

export interface PlatformPayoutResult {
  paycrestOrderId: string;
  receiveAddress: string;
  txHash: string;
  totalSentUsdc: string;
  rate: number;
}

function getClients() {
  const privateKey = process.env.BASE_PRIVATE_KEY;
  if (!privateKey) throw new PayoutPreflightError("BASE_PRIVATE_KEY not configured");

  const transport = http(process.env.BASE_RPC_URL || "https://mainnet.base.org");
  const account = privateKeyToAccount(privateKey as Hex);
  return {
    account,
    publicClient: createPublicClient({ chain: base, transport }),
    walletClient: createWalletClient({ account, chain: base, transport }),
  };
}

export async function executePlatformPayout(
  params: PlatformPayoutParams,
): Promise<PlatformPayoutResult> {
  const apiKey = process.env.PAYCREST_API_KEY;
  const returnAddress = process.env.BASE_RETURN_ADDRESS;
  if (!apiKey || !returnAddress) {
    throw new PayoutPreflightError("Payout configuration incomplete");
  }
  if (!Number.isFinite(params.amountUsdc) || params.amountUsdc <= 0) {
    throw new PayoutPreflightError("Payout amount must be a positive number");
  }

  const { account, publicClient, walletClient } = getClients();
  const paycrest = new PaycrestAdapter(apiKey);

  // Rate comes from Paycrest, never from a caller — a caller-supplied rate is
  // a direct "pay me an arbitrary amount of fiat" hole on platform funds.
  const rate = await paycrest.getRate(
    "USDC",
    String(params.amountUsdc),
    params.currency,
    { network: "base", providerId: params.providerId },
  );

  // Check funds before creating an order, so a short wallet can't orphan one.
  const gasFloor = parseEther(process.env.PAYOUT_MIN_GAS_ETH || "0.0005");
  const [usdcBalance, ethBalance] = await Promise.all([
    publicClient.readContract({
      address: BASE_USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    }),
    publicClient.getBalance({ address: account.address }),
  ]);
  if (ethBalance < gasFloor) {
    throw new PayoutPreflightError(
      `Payout wallet ETH ${formatUnits(ethBalance, 18)} below floor; refusing to submit`,
    );
  }

  const order = await paycrest.createOrder({
    amount: params.amountUsdc,
    token: "USDC",
    network: "base",
    rate,
    recipient: {
      institution: params.recipient.institution,
      accountIdentifier: params.recipient.accountIdentifier,
      accountName: params.recipient.accountName,
      currency: params.currency,
      memo: params.memo || "Settu cashback",
    },
    returnAddress,
  });

  if (!order?.id || !order?.receiveAddress) {
    throw new PayoutPreflightError("Paycrest order missing id or receiveAddress");
  }

  // Paycrest expects the order amount plus its own fees at the receive address.
  const totalUsdc =
    parseFloat(order.amount) +
    parseFloat(order.senderFee ?? "0") +
    parseFloat(order.transactionFee ?? "0");
  if (!Number.isFinite(totalUsdc) || totalUsdc <= 0) {
    throw new PayoutPreflightError("Paycrest returned an unusable order total");
  }

  const value = parseUnits(totalUsdc.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  if (usdcBalance < value) {
    throw new PayoutPreflightError(
      `Payout wallet USDC ${formatUnits(usdcBalance, USDC_DECIMALS)} short of ${totalUsdc}`,
    );
  }

  // Last point at which failure is still clean; everything after may have moved funds.
  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({
      address: BASE_USDC,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [order.receiveAddress as Hex, value],
    });
  } catch (error: any) {
    throw new PayoutPreflightError(
      `USDC transfer rejected before broadcast: ${error?.message ?? error}`,
    );
  }

  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new PayoutBroadcastError("USDC transfer reverted", txHash, order.id);
    }
  } catch (error: any) {
    if (error instanceof PayoutBroadcastError) throw error;
    throw new PayoutBroadcastError(
      `Could not confirm USDC transfer: ${error?.message ?? error}`,
      txHash,
      order.id,
    );
  }

  return {
    paycrestOrderId: order.id,
    receiveAddress: order.receiveAddress,
    txHash,
    totalSentUsdc: totalUsdc.toFixed(USDC_DECIMALS),
    rate,
  };
}
