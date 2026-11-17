/**
 * Handlers behind the admin console's Bridge section (Task 17):
 *
 *   GET/PUT /api/admin/bridge/fee       fee settings by speed + audit
 *   GET/POST /api/admin/bridge/caps     live on-chain limits; POST builds an
 *                                       UNSIGNED owner tx for the browser wallet
 *   GET  /api/admin/bridge/list         recent/pending bridges (or one by ?id=)
 *   POST /api/admin/bridge/revive       reviveStuckTransfer, then scheduleDrive
 *   GET  /api/admin/bridge/relayers     relayer native balances on all 8 chains
 *
 * Pure over injected deps so tests never touch Redis or an RPC; the routes
 * are thin wrappers. Every handler checks admin auth first. Failures are
 * `{ error, code }` and never carry a stack or an upstream error message.
 */

import { Redis } from "@upstash/redis";
import type { NextRequest } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, getAddress, http, isAddress } from "viem";
import { isAuthorisedAdmin } from "./auth";
import { recordAdminAction, type AuditEntry } from "./audit";
import { fetchHorizonAccount } from "../bridge/address-live";
import { toStatusView, type BridgeStatusView } from "../bridge/bridge-store";
import { BRIDGE_CHAINS, type BridgeChainKey } from "../bridge/chains";
import {
  DEFAULT_FEE_CAP_BPS,
  getBridgeFeeBps,
  listBridgeFeeAudit,
  setBridgeFeeBps,
  validateFeeBps,
  type FeeAuditEntry,
} from "../bridge/fee-settings";
import {
  buildSetLimitTx,
  lowestDeployedCapBps,
  OWNER_LIMITS,
  OwnerTxError,
  readAllLimits,
  type ChainLimitsRow,
  type OwnerLimit,
  type OwnerTx,
} from "../bridge/owner-txs";
import type { Speed } from "../bridge/quote-math";
import { scheduleDrive } from "../bridge/schedule";
import { getCctpTransfer, listPendingTransfers, type CctpTransferRecord } from "../cctp/cctp-store";
import type { ReviveResult } from "../cctp/revive";

export interface AdminResult {
  status: number;
  body: unknown;
}

export interface AdminBridgeRow extends BridgeStatusView {
  recordStatus: CctpTransferRecord["status"];
  speed: "fast" | "standard";
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RelayerRow {
  chain: BridgeChainKey;
  label: string;
  symbol: string;
  decimals: number;
  status: "ok" | "not_configured" | "error";
  address?: string;
  balanceAtomic?: string;
}

export interface BridgeAdminDeps {
  isAdmin(request: NextRequest): boolean;
  getFeeBps(speed: Speed): Promise<number>;
  setFeeBps(speed: Speed, bps: number, actor: string, lowestCapBps: number): Promise<void>;
  feeAudit(limit: number): Promise<FeeAuditEntry[]>;
  /** BRIDGE_MAX_FEE_BPS / DEFAULT_FEE_CAP_BPS, used when no contract is deployed. */
  envCapBps(): number;
  readAllLimits(): Promise<ChainLimitsRow[]>;
  buildSetLimitTx(chain: BridgeChainKey, limit: OwnerLimit, value: bigint, owner: string): Promise<OwnerTx>;
  listBridges(): Promise<AdminBridgeRow[]>;
  getBridge(id: string): Promise<AdminBridgeRow | null>;
  revive(id: string): Promise<ReviveResult>;
  scheduleDrive(id: string): Promise<void>;
  recordAction(entry: Omit<AuditEntry, "at">): Promise<void>;
  relayerBalances(): Promise<RelayerRow[]>;
}

const UNAUTHORIZED: AdminResult = { status: 401, body: { error: "Unauthorized", code: "unauthorized" } };
const fail = (status: number, code: string, error: string): AdminResult => ({ status, body: { error, code } });
const UNAVAILABLE = fail(503, "unavailable", "Couldn't complete that right now — try again in a moment.");

function logFailure(where: string, e: unknown): void {
  console.error(`[admin/bridge] ${where} failed:`, e instanceof Error ? `${e.name}: ${e.message}` : "unknown");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function operatorOf(body: Record<string, unknown>): string | null {
  const op = typeof body.operator === "string" ? body.operator.trim() : "";
  return op.length > 1 ? op.slice(0, 80) : null;
}

const OPERATOR_REQUIRED = fail(
  400,
  "operator_required",
  "Enter your name at the top first — every action is attributed.",
);

type CapResolution = { ok: true; bps: number; source: "chain" | "env" } | { ok: false; result: AdminResult };

async function resolveLowestCap(d: BridgeAdminDeps): Promise<CapResolution> {
  const low = lowestDeployedCapBps(await d.readAllLimits());
  if (low === null) {
    return {
      ok: false,
      result: fail(503, "cap_unavailable", "Couldn't read the on-chain cap on every deployed chain. Try again."),
    };
  }
  if (low === undefined) return { ok: true, bps: d.envCapBps(), source: "env" };
  return { ok: true, bps: low, source: "chain" };
}

// ---------------------------------------------------------------- fee

export async function bridgeFeeGet(request: NextRequest, overrides: Partial<BridgeAdminDeps> = {}): Promise<AdminResult> {
  const d = withDefaults(overrides);
  if (!d.isAdmin(request)) return UNAUTHORIZED;
  try {
    const [standardBps, fastBps, audit, cap] = await Promise.all([
      d.getFeeBps("standard"),
      d.getFeeBps("fast"),
      d.feeAudit(20),
      resolveLowestCap(d),
    ]);
    return {
      status: 200,
      body: {
        standardBps,
        fastBps,
        audit,
        lowestCapBps: cap.ok ? cap.bps : null,
        capSource: cap.ok ? cap.source : "unavailable",
      },
    };
  } catch (e) {
    logFailure("fee GET", e);
    return UNAVAILABLE;
  }
}

export async function bridgeFeePut(
  request: NextRequest,
  body: unknown,
  overrides: Partial<BridgeAdminDeps> = {},
): Promise<AdminResult> {
  const d = withDefaults(overrides);
  if (!d.isAdmin(request)) return UNAUTHORIZED;
  if (!isRecord(body)) return fail(400, "invalid_request", "Invalid request.");
  const speed = body.speed;
  if (speed !== "standard" && speed !== "fast") return fail(400, "invalid_request", "Speed must be standard or fast.");
  const feeBps = body.feeBps;
  if (typeof feeBps !== "number" || !Number.isInteger(feeBps)) {
    return fail(400, "invalid_fee", "Fee must be whole basis points.");
  }
  const operator = operatorOf(body);
  if (!operator) return OPERATOR_REQUIRED;

  try {
    const cap = await resolveLowestCap(d);
    if (!cap.ok) return cap.result;
    const invalid = validateFeeBps(feeBps, cap.bps);
    if (invalid) {
      return fail(400, feeBps > cap.bps ? "fee_above_cap" : "invalid_fee", invalid);
    }
    await d.setFeeBps(speed, feeBps, operator, cap.bps);
    const [standardBps, fastBps] = await Promise.all([d.getFeeBps("standard"), d.getFeeBps("fast")]);
    return { status: 200, body: { standardBps, fastBps, lowestCapBps: cap.bps } };
  } catch (e) {
    logFailure("fee PUT", e);
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------- caps

/** Adds label/family so the client never imports the chain registry (server env). */
function serialiseRow(r: ChainLimitsRow): Record<string, unknown> {
  const c = BRIDGE_CHAINS[r.chain];
  const meta = { label: c?.label ?? r.chain, family: c?.family };
  if (r.status !== "ok") return { ...r, ...meta };
  return {
    ...r,
    ...meta,
    maxFeeBps: r.maxFeeBps.toString(),
    maxNetworkFee: r.maxNetworkFee.toString(),
    maxNativeFee: r.maxNativeFee.toString(),
  };
}

export async function bridgeCapsGet(request: NextRequest, overrides: Partial<BridgeAdminDeps> = {}): Promise<AdminResult> {
  const d = withDefaults(overrides);
  if (!d.isAdmin(request)) return UNAUTHORIZED;
  try {
    const [rows, standardBps, fastBps] = await Promise.all([
      d.readAllLimits(),
      d.getFeeBps("standard"),
      d.getFeeBps("fast"),
    ]);
    const low = lowestDeployedCapBps(rows);
    return {
      status: 200,
      body: {
        chains: rows.map(serialiseRow),
        fee: { standardBps, fastBps },
        lowestCapBps: low === undefined ? d.envCapBps() : low,
        capSource: low === undefined ? "env" : low === null ? "unavailable" : "chain",
      },
    };
  } catch (e) {
    logFailure("caps GET", e);
    return UNAVAILABLE;
  }
}

/** Body: { chain, limit, value: decimal string (atomic units / bps), ownerAddress }. */
export async function bridgeCapsPost(
  request: NextRequest,
  body: unknown,
  overrides: Partial<BridgeAdminDeps> = {},
): Promise<AdminResult> {
  const d = withDefaults(overrides);
  if (!d.isAdmin(request)) return UNAUTHORIZED;
  if (!isRecord(body)) return fail(400, "invalid_request", "Invalid request.");
  const { chain, limit, value, ownerAddress } = body;
  if (typeof chain !== "string" || !(chain in BRIDGE_CHAINS)) return fail(400, "invalid_request", "Unknown chain.");
  if (typeof limit !== "string" || !OWNER_LIMITS.includes(limit as OwnerLimit)) {
    return fail(400, "invalid_request", "Unknown limit.");
  }
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) {
    return fail(400, "invalid_value", "The value must be a whole number in the contract's units.");
  }
  if (typeof ownerAddress !== "string" || !ownerAddress) return fail(400, "invalid_owner", "Connect the owner wallet.");
  try {
    const tx = await d.buildSetLimitTx(chain as BridgeChainKey, limit as OwnerLimit, BigInt(value), ownerAddress);
    return { status: 200, body: tx };
  } catch (e) {
    if (e instanceof OwnerTxError) return fail(400, e.code, e.message);
    logFailure("caps POST", e);
    return fail(503, "unavailable", "Couldn't prepare the transaction right now — try again in a moment.");
  }
}

// ---------------------------------------------------------------- bridges

export function toAdminRow(r: CctpTransferRecord): AdminBridgeRow {
  return {
    ...toStatusView(r),
    recordStatus: r.status,
    speed: r.bridge!.speed,
    attempts: r.attempts,
    ...(r.lastError ? { lastError: r.lastError } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Bridge records only, newest first, at most `limit`. */
export function selectRecentBridges(
  records: readonly (CctpTransferRecord | null | undefined)[],
  limit: number,
): AdminBridgeRow[] {
  const seen = new Set<string>();
  return records
    .filter((r): r is CctpTransferRecord => !!r && r.direction === "bridge" && !!r.bridge)
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map(toAdminRow);
}

export async function bridgeListGet(
  request: NextRequest,
  id: string | null,
  overrides: Partial<BridgeAdminDeps> = {},
): Promise<AdminResult> {
  const d = withDefaults(overrides);
  if (!d.isAdmin(request)) return UNAUTHORIZED;
  try {
    const q = id?.trim().toLowerCase();
    if (q) {
      const one = await d.getBridge(q);
      return { status: 200, body: { bridges: one ? [one] : [] } };
    }
    return { status: 200, body: { bridges: await d.listBridges() } };
  } catch (e) {
    logFailure("list", e);
    return UNAVAILABLE;
  }
}

export async function bridgeRevivePost(
  request: NextRequest,
  body: unknown,
  overrides: Partial<BridgeAdminDeps> = {},
): Promise<AdminResult> {
  const d = withDefaults(overrides);
  if (!d.isAdmin(request)) return UNAUTHORIZED;
  if (!isRecord(body)) return fail(400, "invalid_request", "Invalid request.");
  const id = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
  if (!id) return fail(400, "invalid_request", "Missing bridge id.");
  const operator = operatorOf(body);
  if (!operator) return OPERATOR_REQUIRED;

  try {
    const before = await d.getBridge(id);
    if (!before) return fail(404, "not_found", "No bridge with that id.");
    if (before.recordStatus !== "failed") {
      return fail(409, "not_failed", `This bridge is ${before.recordStatus}, not failed — nothing to revive.`);
    }
    const result = await d.revive(id);
    if (result.ok) {
      try {
        await d.scheduleDrive(id);
      } catch (e) {
        // The 5-minute event sweep still drives it.
        logFailure("revive scheduleDrive", e);
      }
    }
    await d.recordAction({
      action: "bridge-revive",
      orderId: id,
      operator,
      outcome: result.ok ? "revived" : "error",
      detail: result.message,
    });
    if (!result.ok) return fail(409, "revive_failed", result.message);
    return { status: 200, body: { ok: true, message: result.message, bridge: await d.getBridge(id) } };
  } catch (e) {
    logFailure("revive", e);
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------- relayers

export interface RelayerDeps {
  env(name: string): string | undefined;
  evmBalance(chain: BridgeChainKey, address: string): Promise<bigint>;
  stellarBalance(address: string): Promise<bigint>;
  solanaBalance(address: string): Promise<bigint>;
}

const RELAYER_ENV = {
  evm: "BRIDGE_EVM_RELAYER_ADDRESS",
  stellar: "BRIDGE_STELLAR_RELAYER_ADDRESS",
  solana: "BRIDGE_SOLANA_RELAYER_ADDRESS",
} as const;
const NATIVE_DECIMALS = { evm: 18, stellar: 7, solana: 9 } as const;

/** One row per chain. Addresses come from env (addresses only, never keys). */
export async function readRelayerBalances(d: RelayerDeps): Promise<RelayerRow[]> {
  const chains = Object.values(BRIDGE_CHAINS);
  return Promise.all(
    chains.map(async (c): Promise<RelayerRow> => {
      const base = {
        chain: c.key,
        label: c.label,
        symbol: c.nativeSymbol,
        decimals: NATIVE_DECIMALS[c.family],
      };
      const address = d.env(RELAYER_ENV[c.family])?.trim();
      if (!address) return { ...base, status: "not_configured" };
      try {
        const bal =
          c.family === "evm"
            ? await d.evmBalance(c.key, address)
            : c.family === "stellar"
              ? await d.stellarBalance(address)
              : await d.solanaBalance(address);
        return { ...base, status: "ok", address, balanceAtomic: bal.toString() };
      } catch (e) {
        logFailure(`relayer balance ${c.key}`, e);
        return { ...base, status: "error", address };
      }
    }),
  );
}

export async function bridgeRelayersGet(
  request: NextRequest,
  overrides: Partial<BridgeAdminDeps> = {},
): Promise<AdminResult> {
  const d = withDefaults(overrides);
  if (!d.isAdmin(request)) return UNAUTHORIZED;
  try {
    return { status: 200, body: { relayers: await d.relayerBalances() } };
  } catch (e) {
    logFailure("relayers", e);
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------- defaults

const RPC_TIMEOUT_MS = 8_000;
const RECENT_LIMIT = 50;
const SCAN_MAX_KEYS = 1_000;

let redis: Redis | null = null;
function getRedis(): Redis {
  redis ??= new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  return redis;
}

/**
 * Pending ids plus a bounded SCAN of transfer keys (records have a 7-day TTL),
 * so failed/completed bridges — which leave the pending set — still show.
 */
async function listRecentBridgesDefault(): Promise<AdminBridgeRow[]> {
  const r = getRedis();
  const ids = new Set(await listPendingTransfers());
  let cursor = "0";
  let scanned = 0;
  do {
    const [next, keys] = await r.scan(cursor, { match: "cctp:transfer:*", count: 200 });
    for (const k of keys) ids.add(k.slice("cctp:transfer:".length));
    scanned += keys.length;
    cursor = String(next);
  } while (cursor !== "0" && scanned < SCAN_MAX_KEYS);

  const all = [...ids];
  const records: (CctpTransferRecord | null)[] = [];
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100);
    records.push(...(await r.mget<(CctpTransferRecord | null)[]>(...chunk.map((id) => `cctp:transfer:${id}`))));
  }
  return selectRecentBridges(records, RECENT_LIMIT);
}

function envCapBpsDefault(): number {
  const raw = process.env.BRIDGE_MAX_FEE_BPS?.trim();
  if (!raw) return DEFAULT_FEE_CAP_BPS;
  if (!/^\d+$/.test(raw) || Number(raw) > 10_000) throw new Error("BRIDGE_MAX_FEE_BPS is invalid");
  return Number(raw);
}

function evmBalanceDefault(chain: BridgeChainKey, address: string): Promise<bigint> {
  const envVar = BRIDGE_CHAINS[chain].rpcEnvVar;
  const rpc = process.env[envVar];
  if (!rpc) throw new Error(`${envVar} is not set`);
  if (!isAddress(address, { strict: false })) throw new Error("BRIDGE_EVM_RELAYER_ADDRESS is not an EVM address");
  return createPublicClient({ transport: http(rpc, { timeout: RPC_TIMEOUT_MS }) }).getBalance({
    address: getAddress(address),
  });
}

/** Total native XLM in stroops (not spendable; the console shows the raw balance). */
async function stellarBalanceDefault(address: string): Promise<bigint> {
  const acct = await fetchHorizonAccount(address);
  const native = acct?.balances.find((b) => b.asset_type === "native");
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(String(native?.balance ?? "0"));
  if (!m) throw new Error("unexpected Horizon balance");
  return BigInt(m[1] + (m[2] ?? "").padEnd(7, "0"));
}

async function solanaBalanceDefault(address: string): Promise<bigint> {
  const url = process.env.SOLANA_RPC_URL;
  if (!url) throw new Error("SOLANA_RPC_URL is not set");
  return BigInt(await new Connection(url, "confirmed").getBalance(new PublicKey(address)));
}

async function getBridgeDefault(id: string): Promise<AdminBridgeRow | null> {
  const r = await getCctpTransfer(id);
  return r && r.direction === "bridge" && r.bridge ? toAdminRow(r) : null;
}

export function defaultBridgeAdminDeps(): BridgeAdminDeps {
  return {
    isAdmin: isAuthorisedAdmin,
    getFeeBps: (s) => getBridgeFeeBps(s),
    setFeeBps: setBridgeFeeBps,
    feeAudit: listBridgeFeeAudit,
    envCapBps: envCapBpsDefault,
    readAllLimits: () => readAllLimits(),
    buildSetLimitTx: (c, l, v, o) => buildSetLimitTx(c, l, v, o),
    listBridges: listRecentBridgesDefault,
    getBridge: getBridgeDefault,
    // Lazy: revive.ts pulls in the onramp store and the mint paths.
    revive: async (id) => (await import("../cctp/revive")).reviveStuckTransfer(id),
    scheduleDrive: (id) => scheduleDrive(id, 0),
    recordAction: recordAdminAction,
    relayerBalances: () =>
      readRelayerBalances({
        env: (k) => process.env[k],
        evmBalance: evmBalanceDefault,
        stellarBalance: stellarBalanceDefault,
        solanaBalance: solanaBalanceDefault,
      }),
  };
}

function withDefaults(overrides: Partial<BridgeAdminDeps>): BridgeAdminDeps {
  const given = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined),
  ) as Partial<BridgeAdminDeps>;
  return { ...defaultBridgeAdminDeps(), ...given };
}
