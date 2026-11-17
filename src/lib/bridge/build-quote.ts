/**
 * Builds and signs a user-bridge quote (spec §6–§8). The source-chain Settu
 * contract charges exactly what this signs, so every input is validated and
 * every missing input fails closed: nothing is signed unless the source and
 * destination addresses pass, the fee setting is sane, and every live read
 * (Horizon / Solana RPC, Iris, gas + price, native balance) succeeded.
 *
 * Units: the breakdown is always 6-decimal USDC. When the SOURCE is Stellar
 * (7-decimal USDC), the signed amount/settuFee/networkFee/maxFee are the
 * breakdown values × 10 (Ruling J). nativeFee is in the source chain's
 * native units and is never scaled.
 *
 * Never log or return key material from here.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, http, type Hex } from "viem";
import { buildForwarderHookData, contractStrkeyToBytes32Hex } from "../cctp/address-encoding";
import { CCTP_CONFIG, FINALITY_THRESHOLD } from "../cctp/constants";
import { getFastMinimumFeeBps } from "../cctp/iris-client";
import { requireSolanaRpcUrl } from "../solana/config";
import { validateDestinationAddress } from "./address";
import {
  checkDestinationLive as liveCheck,
  deriveUsdcAta,
  fetchHorizonAccount,
  type LiveCheckResult,
} from "./address-live";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";
import { bridgeContractFor as envBridgeContractFor } from "./contracts";
import { DEFAULT_FEE_CAP_BPS, getBridgeFeeBps, type FeeReader } from "./fee-settings";
import { estimateNetworkFee as estimateNetworkFeeDefault, NetworkFeeUnavailableError } from "./network-fee";
import {
  encodeQuoteBytes,
  loadEd25519QuoteSignerSecret,
  loadEvmQuoteSignerKey,
  signEd25519Quote,
  signEvmQuote,
  type BridgeQuote,
} from "./quote";
import { saveQuoteRecord as saveQuoteRecordDefault, type QuoteRecord } from "./quote-record";
import { computeBreakdown, type Breakdown, type Speed } from "./quote-math";

export const QUOTE_UNAVAILABLE_MESSAGE = "Couldn't get a price right now — try again in a moment";

/** Seconds a signed quote stays valid. */
export const QUOTE_TTL_SECONDS = 120;

/**
 * Allowance for the user's OWN source-chain gas in native mode, on top of
 * nativeFee. ESTIMATES (Task 14 measures real values):
 * - EVM: OWN_GAS_UNITS_EVM × the chain's current maxFeePerGas. 300k gas covers
 *   the USDC approve (~50k) plus the SettuBridge call (fee transfers +
 *   depositForBurnWithHook, ~200k) with headroom.
 * - Stellar: 0.1 XLM for the Soroban invoke fee. The balance compared against
 *   is the SPENDABLE balance (balance − minimum reserve − selling liabilities).
 * - Solana: 0.002 SOL = signature + priority fees, plus keeping the wallet
 *   above the 0.00089088 SOL rent-exempt minimum.
 */
export const OWN_GAS_UNITS_EVM = BigInt(300_000);
export const OWN_GAS_STELLAR_STROOPS = BigInt(1_000_000);
export const OWN_GAS_SOLANA_LAMPORTS = BigInt(2_000_000);

export type NetworkFeeMode = "usdc" | "native";

export interface QuoteRequest {
  source: BridgeChainKey;
  dest: BridgeChainKey;
  amount: string;
  speed: Speed;
  /** The user's source-chain address. */
  user: string;
  recipient: string;
  networkFeeMode: NetworkFeeMode;
}

type Stringified<T> = {
  [K in keyof T]: T[K] extends bigint ? string : T[K] extends bigint | undefined ? string | undefined : T[K];
};

export type SerializedBridgeQuote = Stringified<BridgeQuote>;
export type SerializedBreakdown = Stringified<Breakdown>;

export interface QuoteSuccess {
  quote: SerializedBridgeQuote;
  /** 0x hex: 65-byte EIP-712 signature (EVM source) or 64-byte ed25519 (Stellar/Solana source). */
  signature: string;
  breakdown: SerializedBreakdown;
  /** Unix seconds; equals quote.deadline. */
  expiresAt: number;
  /** The source chain's Settu bridge contract the quote is bound to. */
  contract: string;
}

export interface QuoteError {
  error: string;
  code: string;
}

export type QuoteResponse = QuoteSuccess | QuoteError;

export interface BuildQuoteDeps {
  /** Unix seconds. */
  now(): number;
  randomBytes(n: number): Uint8Array;
  getFeeBps(speed: Speed): Promise<number>;
  /** Reader passed to getBridgeFeeBps by the default getFeeBps. */
  feeReader?: FeeReader;
  /** The fee cap in bps; throws (→ fee_config) when misconfigured. */
  maxFeeBps(): number;
  /**
   * Iris Fast minimum fee (bps) for the route, or null when Iris offers no
   * valid Fast fee (→ fast_unavailable). Throws on HTTP errors (→ unavailable).
   */
  getFastFeeBps(p: { sourceDomain: number; destDomain: number }): Promise<number | null>;
  estimateNetworkFee(
    dest: BridgeChainKey,
    source: BridgeChainKey,
    opts: { needsSolanaAta: boolean },
  ): Promise<{ usdcAtomic: bigint; nativeAtomic: bigint }>;
  checkDestinationLive(chain: BridgeChainKey, address: string): Promise<LiveCheckResult>;
  /** Spendable native balance of `user` on `chain`, in native atomic units. */
  nativeBalance(chain: BridgeChainKey, user: string): Promise<bigint>;
  /** Estimated native cost of the user's own source transaction. */
  ownGasAllowance(chain: BridgeChainKey): Promise<bigint>;
  bridgeContractFor(chain: BridgeChainKey): string;
  evmSignerKey(): Hex;
  ed25519SignerSecret(): Uint8Array;
  /** Best-effort: records what the quote promised, keyed by nonce (failure never fails the quote). */
  saveQuoteRecord(nonce: string, rec: QuoteRecord): Promise<void>;
}

// ---------------------------------------------------------------- HTTP mapping

const STATUS_409 = new Set(["fast_unavailable"]);
const STATUS_503 = new Set(["fee_config", "unavailable"]);
const STATUS_500 = new Set(["internal"]);

export function httpStatusFor(code: string): number {
  if (STATUS_409.has(code)) return 409;
  if (STATUS_503.has(code)) return 503;
  if (STATUS_500.has(code)) return 500;
  return 400;
}

// ---------------------------------------------------------------- helpers

const ZERO = BigInt(0);
const TEN = BigInt(10);
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

/** Input cap, checked before any network call. */
const MAX_AMOUNT_INT_DIGITS = 20;
const MAX_AMOUNT_LENGTH = 32;

const FAST_UNAVAILABLE_MESSAGE = "Fast transfer is unavailable for this route right now.";

function fail(code: string, error: string): QuoteError {
  return { error, code };
}

const unavailable = (): QuoteError => fail("unavailable", QUOTE_UNAVAILABLE_MESSAGE);

function isChainKey(v: unknown): v is BridgeChainKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(BRIDGE_CHAINS, v);
}

function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/** Ruling J: 6-dp → 7-dp for a Stellar source. */
function scaleForSource(source: BridgeChainKey, v: bigint): bigint {
  if (BRIDGE_CHAINS[source].usdcDecimals !== 7) return v;
  const scaled = v * TEN;
  if (scaled % TEN !== ZERO) throw new Error("internal: 7-dp scaling produced a non-multiple of 10");
  return scaled;
}

function readCapFromEnv(): number {
  const raw = process.env.BRIDGE_MAX_FEE_BPS?.trim();
  if (!raw) return DEFAULT_FEE_CAP_BPS;
  if (!/^\d+$/.test(raw)) throw new Error("BRIDGE_MAX_FEE_BPS must be a whole number of bps");
  const n = Number(raw);
  if (n > 10_000) throw new Error("BRIDGE_MAX_FEE_BPS must be at most 10000");
  return n;
}

function mintRecipientFor(
  dest: BridgeChainKey,
  recipient: string,
  live: LiveCheckResult & { ok: true },
): { mintRecipient: `0x${string}`; hookData: `0x${string}` } {
  switch (BRIDGE_CHAINS[dest].family) {
    case "evm": {
      const hex = recipient.replace(/^0x/i, "").toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error("internal: bad EVM recipient");
      return { mintRecipient: `0x${"0".repeat(24)}${hex}`, hookData: "0x" };
    }
    case "solana": {
      if (!live.solanaAta) throw new Error("internal: Solana live check returned no ATA");
      return { mintRecipient: toHex(new PublicKey(live.solanaAta).toBytes()), hookData: "0x" };
    }
    case "stellar":
      return {
        mintRecipient: contractStrkeyToBytes32Hex(CCTP_CONFIG.stellarCctpForwarder),
        hookData: buildForwarderHookData(recipient),
      };
  }
}

export function serializeQuote(q: BridgeQuote): SerializedBridgeQuote {
  return {
    ...q,
    amount: q.amount.toString(),
    settuFee: q.settuFee.toString(),
    networkFee: q.networkFee.toString(),
    nativeFee: q.nativeFee.toString(),
    maxFee: q.maxFee.toString(),
  };
}

export function deserializeQuote(q: SerializedBridgeQuote): BridgeQuote {
  return {
    ...q,
    amount: BigInt(q.amount),
    settuFee: BigInt(q.settuFee),
    networkFee: BigInt(q.networkFee),
    nativeFee: BigInt(q.nativeFee),
    maxFee: BigInt(q.maxFee),
  };
}

function serializeBreakdown(b: Breakdown): SerializedBreakdown {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(b)) out[k] = typeof v === "bigint" ? v.toString() : v;
  return out as SerializedBreakdown;
}

// ---------------------------------------------------------------- buildQuote

export async function buildQuote(
  req: QuoteRequest,
  overrides: Partial<BuildQuoteDeps> = {},
): Promise<QuoteResponse> {
  const given = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined),
  ) as Partial<BuildQuoteDeps>;
  const d: BuildQuoteDeps = { ...defaultBuildQuoteDeps(given.feeReader), ...given };

  // ---- request shape
  if (!req || typeof req !== "object") return fail("invalid_request", "Invalid request.");
  const { source, dest, amount, speed, networkFeeMode } = req;
  if (!isChainKey(source) || !isChainKey(dest)) {
    return fail("unsupported_chain", "That network isn't supported.");
  }
  if (source === dest) {
    return fail("same_chain", "Pick two different networks.");
  }
  if (speed !== "fast" && speed !== "standard") return fail("invalid_speed", "Pick Fast or Standard.");
  if (networkFeeMode !== "usdc" && networkFeeMode !== "native") {
    return fail("invalid_fee_mode", "Pick how to pay the network fee.");
  }
  if (typeof amount !== "string") return fail("invalid_amount", "Enter a valid amount.");
  const amountText = amount.trim();
  const intPart = /^(\d*)/.exec(amountText)![1];
  if (amountText.length > MAX_AMOUNT_LENGTH || intPart.length > MAX_AMOUNT_INT_DIGITS) {
    return fail("invalid_amount", "That amount is too large.");
  }
  // ed25519 sources sign u64 amounts in the source's USDC decimals: reject
  // anything whose whole part alone would overflow (400, not a signing 503).
  if (isChainKey(source) && BRIDGE_CHAINS[source].family !== "evm" && intPart.length > 0) {
    if (BigInt(intPart) * TEN ** BigInt(BRIDGE_CHAINS[source].usdcDecimals) > U64_MAX) {
      return fail("invalid_amount", "That amount is too large.");
    }
  }
  if (typeof req.user !== "string" || typeof req.recipient !== "string") {
    return fail("invalid_request", "Invalid request.");
  }

  // ---- addresses (same family rules for the source as for any destination)
  const src = validateDestinationAddress(source, req.user);
  if (!src.ok) {
    return fail("invalid_source", `Your ${BRIDGE_CHAINS[source].label} wallet address isn't valid.`);
  }
  const user = src.address;
  const dst = validateDestinationAddress(dest, req.recipient);
  if (!dst.ok) return fail(dst.code, dst.message);
  const recipient = dst.address;

  // ---- fee setting: refuse, never clamp
  const feeConfig = () => {
    console.error("[bridge/quote] fee_config: stored fee or cap is invalid");
    return fail("fee_config", "Bridging is paused for maintenance. Try again shortly.");
  };
  let cap: number;
  try {
    cap = d.maxFeeBps();
  } catch {
    return feeConfig();
  }
  let feeBps: number;
  try {
    feeBps = await d.getFeeBps(speed);
  } catch (e) {
    // A Redis outage is "no price right now", not a misconfiguration.
    console.error("[bridge/quote] unavailable (fee read):", e instanceof Error ? e.message : "unknown error");
    return unavailable();
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > cap) return feeConfig();

  const sourceDomain = BRIDGE_CHAINS[source].cctpDomain;
  const destDomain = BRIDGE_CHAINS[dest].cctpDomain;

  // ---- live destination check, Fast fee, network fee: any failure → no quote
  let live: LiveCheckResult;
  let fastFeeBps = 0;
  let netFee: { usdcAtomic: bigint; nativeAtomic: bigint };
  try {
    live = await d.checkDestinationLive(dest, recipient);
    if (!live.ok) return fail(live.code, live.message);
    if (speed === "fast") {
      const bps = await d.getFastFeeBps({ sourceDomain, destDomain });
      if (bps === null) {
        // No valid Fast fee from Iris: a Fast-priced quote would deliver at Standard.
        console.warn(`[bridge/quote] fast_unavailable (no Iris Fast fee) ${source}->${dest}`);
        return fail("fast_unavailable", FAST_UNAVAILABLE_MESSAGE);
      }
      if (typeof bps !== "number" || !Number.isFinite(bps) || bps < 0) {
        throw new Error("Iris returned an invalid Fast fee");
      }
      fastFeeBps = bps;
    }
    netFee = await d.estimateNetworkFee(dest, source, {
      needsSolanaAta: live.needsSolanaAta === true,
    });
  } catch (e) {
    console.error(
      `[bridge/quote] unavailable (${e instanceof NetworkFeeUnavailableError ? "network fee" : "live read"}):`,
      e instanceof Error ? e.message : "unknown error",
    );
    return unavailable();
  }

  // ---- breakdown
  const b = computeBreakdown({
    source,
    dest,
    amount: amountText,
    speed,
    feeBps,
    fastFeeBps,
    networkFeeMode,
    networkFeeAtomic: netFee.usdcAtomic,
    nativeFeeAtomic: netFee.nativeAtomic,
  });
  if ("error" in b) {
    if (b.code === "fast_unavailable") {
      console.warn(`[bridge/quote] fast_unavailable ${source}->${dest}`);
      return fail("fast_unavailable", b.error);
    }
    return fail("invalid_amount", b.error);
  }

  // ---- native mode: the user must hold nativeFee + their own gas
  if (networkFeeMode === "native") {
    let balance: bigint;
    let allowance: bigint;
    try {
      [balance, allowance] = await Promise.all([
        d.nativeBalance(source, user),
        d.ownGasAllowance(source),
      ]);
      if (typeof balance !== "bigint" || typeof allowance !== "bigint" || allowance < ZERO) {
        throw new Error("invalid native balance read");
      }
    } catch (e) {
      console.error("[bridge/quote] unavailable (native balance):", e instanceof Error ? e.message : "unknown error");
      return unavailable();
    }
    if (balance < b.nativeFeeAtomic + allowance) {
      const sym = BRIDGE_CHAINS[source].nativeSymbol;
      return fail("insufficient_native", `Not enough ${sym} to pay the network fee.`);
    }
  }

  // ---- Solana: the mint recipient must be the ATA we derive ourselves
  if (BRIDGE_CHAINS[dest].family === "solana") {
    let expected: string | null = null;
    try {
      expected = deriveUsdcAta(recipient, BRIDGE_CHAINS.solana.usdc);
    } catch {
      expected = null;
    }
    if (!live.solanaAta || expected === null || live.solanaAta !== expected) {
      console.error("[bridge/quote] internal: Solana ATA from the live check does not re-derive");
      return fail("internal", "Something went wrong preparing this transfer. Try again.");
    }
  }

  // ---- the quote
  const contract = d.bridgeContractFor(source);
  const { mintRecipient, hookData } = mintRecipientFor(dest, recipient, live);
  const nonce = d.randomBytes(32);
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) throw new Error("internal: nonce must be 32 bytes");
  const deadline = Math.floor(d.now()) + QUOTE_TTL_SECONDS;

  const quote: BridgeQuote = {
    version: 1,
    sourceDomain,
    destDomain,
    user,
    amount: scaleForSource(source, b.sendAtomic),
    settuFee: scaleForSource(source, b.settuFeeAtomic),
    networkFee: scaleForSource(source, b.networkFeeAtomic),
    nativeFee: b.nativeFeeAtomic,
    mintRecipient,
    hookData,
    maxFee: scaleForSource(source, b.fastFeeMaxAtomic),
    minFinality: speed === "fast" ? FINALITY_THRESHOLD.fast : FINALITY_THRESHOLD.standard,
    deadline,
    nonce: toHex(nonce),
  };

  const family = BRIDGE_CHAINS[source].family;
  let signature: string;
  if (family === "evm") {
    const chainId = BRIDGE_CHAINS[source].chainId;
    if (!chainId) throw new Error(`internal: no chainId for ${source}`);
    signature = await signEvmQuote(quote, chainId, contract as Hex, d.evmSignerKey());
  } else {
    const bytes = encodeQuoteBytes(quote, family, contract);
    signature = toHex(signEd25519Quote(bytes, d.ed25519SignerSecret()));
  }

  try {
    await d.saveQuoteRecord(quote.nonce, {
      source,
      dest,
      speed,
      user,
      recipient,
      maxFeeAtomic: b.fastFeeMaxAtomic.toString(),
      receiveMinAtomic: b.receiveAtomic.toString(),
    });
  } catch (e) {
    console.error("[bridge/quote] quote record write failed:", e instanceof Error ? e.message : "unknown error");
  }

  return {
    quote: serializeQuote(quote),
    signature,
    breakdown: serializeBreakdown(b),
    expiresAt: deadline,
    contract,
  };
}

// ---------------------------------------------------------------- defaults

const RPC_TIMEOUT_MS = 8_000;

function evmClient(chain: BridgeChainKey) {
  const envVar = BRIDGE_CHAINS[chain].rpcEnvVar;
  const rpc = process.env[envVar];
  if (!rpc) throw new Error(`${envVar} is not set`);
  return createPublicClient({ transport: http(rpc, { timeout: RPC_TIMEOUT_MS }) });
}

/** "12.3456789" → 123456789 stroops. */
function xlmToStroops(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(s);
  if (!m) throw new Error("bad XLM amount");
  return BigInt(m[1] + (m[2] ?? "").padEnd(7, "0"));
}

const BASE_RESERVE_STROOPS = BigInt(5_000_000); // 0.5 XLM

/** Native XLM the account can actually spend: balance − min reserve − selling liabilities. */
export async function stellarSpendableStroops(g: string): Promise<bigint> {
  const acct = (await fetchHorizonAccount(g)) as
    | {
        balances: { asset_type: string; balance?: string; selling_liabilities?: string }[];
        subentry_count?: number;
        num_sponsoring?: number;
        num_sponsored?: number;
      }
    | null;
  if (!acct) return ZERO;
  const native = acct.balances.find((b) => b.asset_type === "native");
  if (!native?.balance) return ZERO;
  const entries =
    BigInt(2) +
    BigInt(acct.subentry_count ?? 0) +
    BigInt(acct.num_sponsoring ?? 0) -
    BigInt(acct.num_sponsored ?? 0);
  const spendable =
    xlmToStroops(native.balance) -
    entries * BASE_RESERVE_STROOPS -
    xlmToStroops(native.selling_liabilities ?? "0");
  return spendable > ZERO ? spendable : ZERO;
}

export function defaultBuildQuoteDeps(feeReader?: FeeReader): BuildQuoteDeps {
  return {
    now: () => Math.floor(Date.now() / 1000),
    randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)),
    getFeeBps: (speed) => getBridgeFeeBps(speed, feeReader),
    maxFeeBps: readCapFromEnv,
    getFastFeeBps: getFastMinimumFeeBps,
    estimateNetworkFee: (dest, source, opts) => estimateNetworkFeeDefault(dest, source, opts),
    checkDestinationLive: (chain, address) => liveCheck(chain, address),
    nativeBalance: async (chain, user) => {
      switch (BRIDGE_CHAINS[chain].family) {
        case "evm":
          return evmClient(chain).getBalance({ address: user as Hex });
        case "stellar":
          return stellarSpendableStroops(user);
        case "solana": {
          const conn = new Connection(requireSolanaRpcUrl(), "confirmed");
          return BigInt(await conn.getBalance(new PublicKey(user)));
        }
      }
    },
    ownGasAllowance: async (chain) => {
      switch (BRIDGE_CHAINS[chain].family) {
        case "evm": {
          const fees = await evmClient(chain).estimateFeesPerGas();
          const perGas = fees.maxFeePerGas ?? fees.gasPrice;
          if (!perGas || perGas <= ZERO) throw new Error(`no fee per gas for ${chain}`);
          return OWN_GAS_UNITS_EVM * perGas;
        }
        case "stellar":
          return OWN_GAS_STELLAR_STROOPS;
        case "solana":
          return OWN_GAS_SOLANA_LAMPORTS;
      }
    },
    bridgeContractFor: envBridgeContractFor,
    evmSignerKey: loadEvmQuoteSignerKey,
    ed25519SignerSecret: loadEd25519QuoteSignerSecret,
    saveQuoteRecord: saveQuoteRecordDefault,
  };
}
