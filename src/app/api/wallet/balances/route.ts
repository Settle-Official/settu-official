import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { requireSolanaRpcUrl, SOLANA_CONFIG } from "@/lib/solana/config";
import { EVM_SOURCE_CHAINS } from "@/lib/cctp/evm-chains";
import { STELLAR_HORIZON_URL } from "@/lib/settu-wallet/account";

export const runtime = "nodejs";

export interface ChainBalance {
  code: string;
  amount: string;
}

// Read-only and address-scoped, so it needs no auth — but the RPC keys behind
// it do, which is why this is a route rather than a client fetch.
export async function GET(request: NextRequest) {
  const chain = request.nextUrl.searchParams.get("chain");
  const address = request.nextUrl.searchParams.get("address")?.trim();
  if (!address) {
    return NextResponse.json({ error: "address is required" }, { status: 400 });
  }

  try {
    if (chain === "stellar") return NextResponse.json({ balances: await stellar(address) });
    if (chain === "solana") return NextResponse.json({ balances: await solana(address) });
    if (chain === "evm") return NextResponse.json({ balances: await evm(address) });
    return NextResponse.json({ error: "unknown chain" }, { status: 400 });
  } catch (error: any) {
    // An unfunded address is the normal case, not an error worth surfacing.
    console.error("[wallet] balances failed:", chain, error?.message);
    return NextResponse.json({ balances: [] });
  }
}

async function stellar(address: string): Promise<ChainBalance[]> {
  const res = await fetch(`${STELLAR_HORIZON_URL}/accounts/${address}`);
  if (!res.ok) return [];
  const balances = ((await res.json())?.balances ?? []) as Array<{
    asset_type: string;
    asset_code?: string;
    balance: string;
  }>;
  return balances.map((b) => ({
    code: b.asset_type === "native" ? "XLM" : (b.asset_code ?? "?"),
    amount: b.balance,
  }));
}

async function solana(address: string): Promise<ChainBalance[]> {
  const connection = new Connection(requireSolanaRpcUrl(), "confirmed");
  const owner = new PublicKey(address);

  const lamports = await connection.getBalance(owner);
  const out: ChainBalance[] = [{ code: "SOL", amount: String(lamports / 1e9) }];

  const tokens = await connection.getParsedTokenAccountsByOwner(owner, {
    mint: new PublicKey(SOLANA_CONFIG.usdcMint),
  });
  const usdc = tokens.value[0]?.account.data.parsed?.info?.tokenAmount?.uiAmount;
  out.push({ code: "USDC", amount: String(usdc ?? 0) });
  return out;
}

async function evm(address: string): Promise<ChainBalance[]> {
  // Base, because that is where an offramp's USDC lives.
  const base = EVM_SOURCE_CHAINS.base;
  const rpcUrl = process.env[base.rpcUrlEnvVar];
  if (!rpcUrl) return [];

  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await res.json())?.result as string | undefined;
  };

  const wei = await call("eth_getBalance", [address, "latest"]);
  const usdc = await call("eth_call", [
    {
      to: base.usdcAddress,
      data: `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}`,
    },
    "latest",
  ]);

  return [
    { code: "ETH", amount: String(Number(BigInt(wei ?? "0x0")) / 1e18) },
    { code: "USDC", amount: String(Number(BigInt(usdc || "0x0")) / 1e6) },
  ];
}
