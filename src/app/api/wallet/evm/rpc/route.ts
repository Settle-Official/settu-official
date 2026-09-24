import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { EVM_SOURCE_CHAINS, type EvmChainKey } from "@/lib/cctp/evm-chains";

export const runtime = "nodejs";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Everything a wallet needs to build, price and broadcast its own transaction,
// and nothing that could ask this server to sign or spend.
const ALLOWED_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_call",
  "eth_estimateGas",
  "eth_getTransactionCount",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBlockByNumber",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_sendRawTransaction",
]);

const RATE_LIMIT = 600;
const RATE_WINDOW_SECONDS = 3600;

/** Read-mostly RPC proxy, so the provider keys never reach the browser. */
export async function POST(request: NextRequest) {
  const network = request.nextUrl.searchParams.get("network") ?? "base";
  const config = EVM_SOURCE_CHAINS[network as EvmChainKey];
  if (!config) {
    return NextResponse.json({ error: "unknown network" }, { status: 400 });
  }
  const rpcUrl = process.env[config.rpcUrlEnvVar];
  if (!rpcUrl) {
    return NextResponse.json({ error: "network unavailable" }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const method = typeof body?.method === "string" ? body.method : "";
  if (!ALLOWED_METHODS.has(method)) {
    return NextResponse.json(
      { error: `method not allowed: ${method}` },
      { status: 403 },
    );
  }

  // Generous: viem makes several reads per transaction. Guards against the
  // proxy being used as free RPC, not against normal use.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const key = `wallet:evm-rpc:${ip}`;
  const used = await redis.incr(key);
  if (used === 1) await redis.expire(key, RATE_WINDOW_SECONDS);
  if (used > RATE_LIMIT) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const upstream = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return NextResponse.json(await upstream.json(), { status: upstream.status });
}
