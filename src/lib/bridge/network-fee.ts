/**
 * Destination network fee estimate.
 *
 * Settu's relayer pays the gas to mint on the destination chain; the user is
 * charged that cost either in USDC or in the SOURCE chain's native token.
 * Undercharging loses money, so every failure (RPC, missing/zero/disagreeing
 * price) throws NetworkFeeUnavailableError: the quote fails closed.
 *
 * Money math is all bigint. Prices arrive as JS numbers (from the price
 * source) and are converted ONCE to 1e8 fixed-point (PRICE_SCALE) bigints;
 * nothing after that touches floating point. Conversions round UP.
 *
 *   usdc6   = ceil(cost * priceE8(dest) * MARGIN / (10^destDec * 1e8) * 1e6)
 *   native  = ceil(usdc6 * 10^srcDec * 1e8 / (1e6 * priceE8(source)))
 */
import { createPublicClient, http } from "viem";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";

export class NetworkFeeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkFeeUnavailableError";
  }
}

/**
 * ESTIMATES, not measurements. Task 14 (testnet) replaces these with measured
 * values. Do not treat them as final.
 */
export const GAS_UNIT_ESTIMATES = {
  /** EVM MessageTransmitter.receiveMessage, gas units. */
  evmReceiveMessageGas: BigInt(200_000),
  /** Solana receive_message: 2 signatures x 5_000 lamports base fee. */
  solanaBaseFeeLamports: BigInt(2) * BigInt(5_000),
  /** Solana priority-fee allowance, lamports. */
  solanaPriorityFeeLamports: BigInt(50_000),
  /** Solana ATA rent-exempt minimum (165-byte token account), lamports. */
  solanaAtaRentLamports: BigInt(2_039_280),
  /** Stellar mint_and_forward, stroops (0.1 XLM). */
  stellarMintAndForwardStroops: BigInt(1_000_000),
} as const;

/** Safety margin on the USD cost, applied once (spec section 12, builder's call). */
export const NETWORK_FEE_MARGIN = 1.25;
// Integer form of NETWORK_FEE_MARGIN (125/100) so no float touches amounts.
const MARGIN_NUM = BigInt(125);
const MARGIN_DEN = BigInt(100);

/** Max allowed relative gap between the two price sources. */
const MAX_PRICE_DIVERGENCE_PERCENT = BigInt(3);

const PRICE_SCALE = BigInt(100_000_000); // 1e8 fixed point
const USDC_DECIMALS = BigInt(6);
const FETCH_TIMEOUT_MS = 5_000;

export interface NetworkFeeDeps {
  /** Destination mint cost in dest native atomic units (wei | lamports | stroops). */
  gasCostNative(dest: BridgeChainKey): Promise<bigint>;
  /** USD price of one whole native token. */
  nativeUsdPrice(chain: BridgeChainKey): Promise<number>;
}

function nativeDecimals(chain: BridgeChainKey): bigint {
  const family = BRIDGE_CHAINS[chain].family;
  return family === "evm" ? BigInt(18) : family === "stellar" ? BigInt(7) : BigInt(9);
}

function priceToFixed(price: number, chain: BridgeChainKey): bigint {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    throw new NetworkFeeUnavailableError(`No valid USD price for ${chain}`);
  }
  const fixed = BigInt(Math.round(price * 1e8));
  if (fixed <= BigInt(0)) throw new NetworkFeeUnavailableError(`USD price for ${chain} rounds to zero`);
  return fixed;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - BigInt(1)) / b;
}

export async function estimateNetworkFee(
  dest: BridgeChainKey,
  source: BridgeChainKey,
  opts: { needsSolanaAta: boolean },
  deps: NetworkFeeDeps = defaultNetworkFeeDeps(opts),
): Promise<{ usdcAtomic: bigint; nativeAtomic: bigint }> {
  try {
    const [cost, destPrice, srcPrice] = await Promise.all([
      deps.gasCostNative(dest),
      deps.nativeUsdPrice(dest),
      dest === source ? Promise.resolve(null) : deps.nativeUsdPrice(source),
    ]);
    if (typeof cost !== "bigint" || cost <= BigInt(0)) {
      throw new NetworkFeeUnavailableError(`No valid gas cost for ${dest}`);
    }
    const destE8 = priceToFixed(destPrice, dest);
    const srcE8 = srcPrice === null ? destE8 : priceToFixed(srcPrice, source);

    const usdcAtomic = ceilDiv(
      cost * destE8 * MARGIN_NUM * BigInt(10) ** USDC_DECIMALS,
      BigInt(10) ** nativeDecimals(dest) * PRICE_SCALE * MARGIN_DEN,
    );
    const nativeAtomic = ceilDiv(
      usdcAtomic * BigInt(10) ** nativeDecimals(source) * PRICE_SCALE,
      BigInt(10) ** USDC_DECIMALS * srcE8,
    );
    return { usdcAtomic, nativeAtomic };
  } catch (e) {
    if (e instanceof NetworkFeeUnavailableError) throw e;
    throw new NetworkFeeUnavailableError(
      `Network fee unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Default dependencies
// ---------------------------------------------------------------------------

export function defaultNetworkFeeDeps(opts: { needsSolanaAta: boolean }): NetworkFeeDeps {
  return {
    gasCostNative: (dest) => defaultGasCostNative(dest, opts),
    nativeUsdPrice: defaultNativeUsdPrice,
  };
}

async function defaultGasCostNative(
  dest: BridgeChainKey,
  opts: { needsSolanaAta: boolean },
): Promise<bigint> {
  const chain = BRIDGE_CHAINS[dest];
  const g = GAS_UNIT_ESTIMATES;
  if (chain.family === "stellar") return g.stellarMintAndForwardStroops;
  if (chain.family === "solana") {
    return (
      g.solanaBaseFeeLamports +
      g.solanaPriorityFeeLamports +
      (opts.needsSolanaAta ? g.solanaAtaRentLamports : BigInt(0))
    );
  }
  const rpc = process.env[chain.rpcEnvVar];
  if (!rpc) throw new NetworkFeeUnavailableError(`${chain.rpcEnvVar} is not set`);
  const client = createPublicClient({ transport: http(rpc, { timeout: FETCH_TIMEOUT_MS }) });
  const fees = await client.estimateFeesPerGas();
  const perGas = fees.maxFeePerGas ?? fees.gasPrice;
  if (!perGas || perGas <= BigInt(0)) {
    throw new NetworkFeeUnavailableError(`No fee per gas from ${dest} RPC`);
  }
  return g.evmReceiveMessageGas * perGas;
}

/** Kraken pair names differ from ours only for none of our symbols, but keep a map. */
const KRAKEN_SYMBOL: Record<string, string> = {
  ETH: "ETH", AVAX: "AVAX", POL: "POL", SOL: "SOL", XLM: "XLM",
};

/** Coinbase `{data:{amount:"123.4"}}` -> number, or null if unusable. */
export function parseCoinbasePrice(body: unknown): number | null {
  const amount = (body as { data?: { amount?: unknown } } | null)?.data?.amount;
  const n = typeof amount === "string" ? Number(amount) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Kraken `{error:[],result:{<key>:{c:["last","vol"]}}}` -> number, or null.
 * Result keys are not stable (e.g. XETHZUSD for ETHUSD), so take the single entry.
 */
export function parseKrakenPrice(body: unknown): number | null {
  const b = body as { error?: unknown[]; result?: Record<string, { c?: unknown[] }> } | null;
  if (!b || (Array.isArray(b.error) && b.error.length > 0) || !b.result) return null;
  const first = Object.values(b.result)[0];
  const last = first?.c?.[0];
  const n = typeof last === "string" ? Number(last) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Combine the two sources: both ok -> higher, unless they differ by more than
 * 3% (throw); one ok -> it; none -> throw. Integer-scaled comparison.
 */
export function combinePrices(a: number | null, b: number | null, chain: string): number {
  if (a === null && b === null) {
    throw new NetworkFeeUnavailableError(`No price source available for ${chain}`);
  }
  if (a === null) return b as number;
  if (b === null) return a;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  const hiE8 = BigInt(Math.round(hi * 1e8));
  const loE8 = BigInt(Math.round(lo * 1e8));
  // diverges if (hi - lo) / lo > 3%  <=>  (hi - lo) * 100 > 3 * lo
  if ((hiE8 - loE8) * BigInt(100) > MAX_PRICE_DIVERGENCE_PERCENT * loE8) {
    throw new NetworkFeeUnavailableError(`Price sources disagree by more than 3% for ${chain}`);
  }
  return hi;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function defaultNativeUsdPrice(chain: BridgeChainKey): Promise<number> {
  const sym = BRIDGE_CHAINS[chain].nativeSymbol;
  const krakenSym = KRAKEN_SYMBOL[sym] ?? sym;
  const [cb, kr] = await Promise.all([
    fetchJson(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`)
      .then(parseCoinbasePrice)
      .catch(() => null),
    fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${krakenSym}USD`)
      .then(parseKrakenPrice)
      .catch(() => null),
  ]);
  return combinePrices(cb, kr, chain);
}
