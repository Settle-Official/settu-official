/**
 * The bridge event sweep (spec §9 "Event sweep"): indexes our contract's
 * `Bridged` events, registers any bridge Settu lost track of, then advances
 * every non-final bridge in `cctp:pending-transfers`. Runs every 5 minutes
 * from the existing QStash schedule on /api/admin/offramp/sweep-burns.
 *
 * Per chain, resumes from the Redis cursor `bridge:sweep-cursor:<chain>`:
 *  - EVM: `eth_getLogs` on our contract address only, in chunks of
 *    EVM_CHUNK_BLOCKS (2,000) blocks, inclusive. The cursor is the last block
 *    fully processed. First run (no cursor): start at latest - 2,000 —
 *    anything older is the register route's / support's job, not the sweep's.
 *  - Stellar: Soroban `getEvents` filtered by our contract id. The cursor is
 *    the RPC's pagination cursor. First run: startLedger = latest - 2,000.
 *  - Solana: out of scope here (Task 8) — skipped with a log line.
 *
 * The cursor only moves after every event in that chunk/page was processed.
 * A retryable failure (RPC, not-indexed, Redis) stops that chain for this run
 * with the cursor untouched, so the next run re-reads the same range (a log
 * that was reorged out simply won't come back). Permanent registration
 * rejections (HTTP-400 BridgeRegisterError: no/invalid event, not a bridge)
 * are logged and skipped so one bad tx can't pin the cursor forever.
 *
 * Bounds (one run must fit the 60 s function limit, after the offramp sweep):
 *  - EVM: at most MAX_CHUNKS_PER_CHAIN chunks (6,000 blocks) per chain per run;
 *    chains run in parallel, each chunk sequentially.
 *  - Stellar: at most MAX_STELLAR_PAGES pages of STELLAR_PAGE_LIMIT events.
 *  - Advance pass: at most MAX_ADVANCES_PER_RUN bridge records.
 * A chain behind by more than that catches up over several runs.
 *
 * Chains whose BRIDGE_CONTRACT_<CHAIN> is unset are skipped (logged): the
 * contracts aren't deployed yet. All I/O is injected (SweepDeps).
 */

import { createPublicClient, http, type Hex } from "viem";
import { Redis } from "@upstash/redis";
import { StrKey, xdr } from "@stellar/stellar-sdk";
import {
  getCctpTransfer,
  listPendingTransfers,
  type CctpStatus,
  type CctpTransferRecord,
} from "../cctp/cctp-store";
import { advanceCctpTransfer } from "../cctp/advance";
import { sorobanRpc } from "../stellar/soroban-rpc";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";
import { bridgeContractFor } from "./contracts";
import { BridgeRegisterError, registerBridge } from "./bridge-store";
import { decodeEvmBridged, decodeStellarBridged, type EvmLogLike } from "./read-source-event";
import { scheduleDrive } from "./schedule";

export const EVM_CHUNK_BLOCKS = 2000;
export const FIRST_RUN_LOOKBACK = 2000;
export const MAX_CHUNKS_PER_CHAIN = 3;
export const STELLAR_PAGE_LIMIT = 100;
export const MAX_STELLAR_PAGES = 3;
export const MAX_ADVANCES_PER_RUN = 25;

const CURSOR_KEY = (chain: BridgeChainKey) => `bridge:sweep-cursor:${chain}`;

export interface EvmSweepLog extends EvmLogLike {
  transactionHash: string;
}

/** One entry of a Soroban `getEvents` response. */
export interface StellarRpcEvent {
  type: string;
  id: string;
  ledger: number;
  contractId: string;
  txHash: string;
  inSuccessfulContractCall?: boolean;
  /** base64 ScVal XDR each. */
  topic: string[];
  /** base64 ScVal XDR. */
  value: string;
}

export interface StellarEventsRequest {
  contractId: string;
  limit: number;
  startLedger?: number;
  cursor?: string;
}

export interface StellarEventsPage {
  events: StellarRpcEvent[];
  latestLedger: number;
  cursor?: string;
}

export interface SweepDeps {
  chains: BridgeChainKey[];
  /** Our contract on `chain`, or null when it isn't configured. */
  contractFor(chain: BridgeChainKey): string | null;
  getCursor(chain: BridgeChainKey): Promise<string | null>;
  setCursor(chain: BridgeChainKey, value: string): Promise<void>;
  evmLatestBlock(chain: BridgeChainKey): Promise<bigint>;
  evmGetLogs(chain: BridgeChainKey, address: string, fromBlock: bigint, toBlock: bigint): Promise<EvmSweepLog[]>;
  stellarLatestLedger(): Promise<number>;
  stellarGetEvents(req: StellarEventsRequest): Promise<StellarEventsPage>;
  getTransfer(id: string): Promise<CctpTransferRecord | null>;
  register(chain: BridgeChainKey, txHash: string): Promise<void>;
  listPending(): Promise<string[]>;
  advance(id: string): Promise<CctpStatus>;
  log(msg: string): void;
}

let redisClient: Redis | null = null;
function redis(): Redis {
  if (!redisClient) {
    // Raw strings: auto-deserialisation would turn an all-digit cursor into a
    // (possibly lossy) number.
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      automaticDeserialization: false,
    });
  }
  return redisClient;
}

function evmClient(chain: BridgeChainKey) {
  const envVar = BRIDGE_CHAINS[chain].rpcEnvVar;
  const url = process.env[envVar];
  if (!url) throw new Error(`${envVar} is not set`);
  return createPublicClient({ transport: http(url) });
}

export const defaultSweepDeps: SweepDeps = {
  chains: Object.keys(BRIDGE_CHAINS) as BridgeChainKey[],
  contractFor(chain) {
    // Unset -> null (skipped: not deployed yet). Set but malformed -> throws,
    // so a typo is logged as an error instead of a silent skip.
    if (!process.env[`BRIDGE_CONTRACT_${chain.toUpperCase()}`]?.trim()) return null;
    return bridgeContractFor(chain);
  },
  getCursor: async (chain) => {
    const v = await redis().get<string>(CURSOR_KEY(chain));
    return v === null || v === undefined ? null : String(v);
  },
  setCursor: async (chain, value) => {
    await redis().set(CURSOR_KEY(chain), value);
  },
  evmLatestBlock: (chain) => evmClient(chain).getBlockNumber(),
  async evmGetLogs(chain, address, fromBlock, toBlock) {
    const logs = await evmClient(chain).getLogs({ address: address as Hex, fromBlock, toBlock });
    return logs.map((l) => ({
      address: l.address,
      topics: l.topics,
      data: l.data,
      transactionHash: l.transactionHash,
    }));
  },
  async stellarLatestLedger() {
    const r = await sorobanRpc("getLatestLedger", {});
    return Number(r.sequence);
  },
  async stellarGetEvents(req) {
    const filters = [{ type: "contract", contractIds: [req.contractId] }];
    const pagination: Record<string, unknown> = { limit: req.limit };
    if (req.cursor) pagination.cursor = req.cursor;
    const params: Record<string, unknown> = { filters, pagination };
    if (!req.cursor) params.startLedger = req.startLedger;
    const r = await sorobanRpc("getEvents", params);
    return {
      events: (r?.events ?? []) as StellarRpcEvent[],
      latestLedger: Number(r?.latestLedger ?? 0),
      ...(typeof r?.cursor === "string" && r.cursor ? { cursor: r.cursor } : {}),
    };
  },
  getTransfer: getCctpTransfer,
  register: async (chain, txHash) => {
    await registerBridge(chain, txHash, (id) => scheduleDrive(id));
  },
  listPending: listPendingTransfers,
  advance: advanceCctpTransfer,
  log: (m) => console.log(m),
};

const isFinal = (s: CctpStatus) => s === "completed" || s === "failed";

/** Ids are the lower-cased source tx hash (see bridge-store normaliseHash). */
const idFor = (txHash: string) => txHash.toLowerCase();

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "unknown");

/**
 * Register one swept event if Settu has no record of it. Returns true when a
 * record was created. Throws on retryable failures (caller stops the chain).
 */
async function handleEvent(
  d: SweepDeps,
  chain: BridgeChainKey,
  txHash: string,
  seen: Set<string>,
): Promise<boolean> {
  const id = idFor(txHash);
  if (seen.has(id)) return false;
  seen.add(id);
  if (await d.getTransfer(id)) return false;
  try {
    await d.register(chain, id);
    return true;
  } catch (e) {
    if (e instanceof BridgeRegisterError && e.status === 400) {
      d.log(`[bridge/sweep] ${chain}: skipping ${id}: ${e.code} (${e.message})`);
      return false;
    }
    throw e;
  }
}

async function sweepEvm(d: SweepDeps, chain: BridgeChainKey, contract: string): Promise<number> {
  const one = BigInt(1);
  const chunk = BigInt(EVM_CHUNK_BLOCKS);
  const latest = await d.evmLatestBlock(chain);
  const cursor = await d.getCursor(chain);
  let from: bigint;
  if (cursor !== null) {
    from = BigInt(cursor) + one;
  } else {
    const start = latest - BigInt(FIRST_RUN_LOOKBACK);
    from = start > BigInt(0) ? start : BigInt(0);
  }
  const seen = new Set<string>();
  let created = 0;
  for (let i = 0; i < MAX_CHUNKS_PER_CHAIN && from <= latest; i++) {
    const end = from + chunk - one;
    const to = end < latest ? end : latest;
    const logs = await d.evmGetLogs(chain, contract, from, to);
    for (const log of logs) {
      if (!decodeEvmBridged([log], contract)) continue; // other events from our contract
      if (await handleEvent(d, chain, log.transactionHash, seen)) created++;
    }
    await d.setCursor(chain, to.toString()); // only after the whole chunk is processed
    from = to + one;
  }
  return created;
}

function toContractEvent(e: StellarRpcEvent): xdr.ContractEvent | null {
  if (!StrKey.isValidContract(e.contractId)) return null;
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    // ContractId is a 32-byte opaque hash; the XDR codec takes the raw bytes.
    contractId: Buffer.from(StrKey.decodeContract(e.contractId)) as unknown as xdr.ContractId,
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: e.topic.map((t) => xdr.ScVal.fromXDR(t, "base64")),
        data: xdr.ScVal.fromXDR(e.value, "base64"),
      }),
    ),
  });
}

async function sweepStellar(d: SweepDeps, contract: string): Promise<number> {
  const chain: BridgeChainKey = "stellar";
  let cursor = await d.getCursor(chain);
  let startLedger: number | undefined;
  if (cursor === null) {
    const latest = await d.stellarLatestLedger();
    startLedger = Math.max(1, latest - FIRST_RUN_LOOKBACK);
  }
  const seen = new Set<string>();
  let created = 0;
  for (let i = 0; i < MAX_STELLAR_PAGES; i++) {
    const page = await d.stellarGetEvents({
      contractId: contract,
      limit: STELLAR_PAGE_LIMIT,
      ...(cursor !== null ? { cursor } : { startLedger }),
    });
    for (const e of page.events) {
      if (e.type !== "contract" || e.contractId !== contract) continue;
      if (e.inSuccessfulContractCall === false) continue;
      let decoded = null;
      try {
        const ce = toContractEvent(e);
        decoded = ce ? decodeStellarBridged([ce], contract) : null;
      } catch (err) {
        d.log(`[bridge/sweep] stellar: skipping undecodable event ${e.id} in ${e.txHash}: ${errMsg(err)}`);
        continue;
      }
      if (!decoded) continue;
      if (await handleEvent(d, chain, e.txHash, seen)) created++;
    }
    const next = page.cursor ?? page.events[page.events.length - 1]?.id;
    if (!next) break;
    await d.setCursor(chain, next); // only after the whole page is processed
    cursor = next;
    if (page.events.length < STELLAR_PAGE_LIMIT) break;
  }
  return created;
}

async function sweepChain(d: SweepDeps, chain: BridgeChainKey): Promise<number> {
  const family = BRIDGE_CHAINS[chain].family;
  if (family === "solana") {
    d.log("[bridge/sweep] solana: skipped — Solana source sweep lands with Task 8");
    return 0;
  }
  try {
    const contract = d.contractFor(chain);
    if (!contract) {
      d.log(`[bridge/sweep] ${chain}: skipped — BRIDGE_CONTRACT_${chain.toUpperCase()} not configured`);
      return 0;
    }
    return family === "evm" ? await sweepEvm(d, chain, contract) : await sweepStellar(d, contract);
  } catch (e) {
    d.log(`[bridge/sweep] ${chain}: stopped this run, cursor kept: ${errMsg(e)}`);
    return 0;
  }
}

export async function sweepBridgedEvents(
  deps: SweepDeps = defaultSweepDeps,
): Promise<{ created: number; advanced: number }> {
  const perChain = await Promise.all(deps.chains.map((c) => sweepChain(deps, c)));
  const created = perChain.reduce((a, b) => a + b, 0);

  let advanced = 0;
  let tried = 0;
  for (const id of await deps.listPending()) {
    if (tried >= MAX_ADVANCES_PER_RUN) break;
    let r: CctpTransferRecord | null;
    try {
      r = await deps.getTransfer(id);
    } catch (e) {
      deps.log(`[bridge/sweep] read ${id} failed: ${errMsg(e)}`);
      continue;
    }
    if (!r || r.direction !== "bridge" || isFinal(r.status)) continue;
    tried++;
    try {
      await deps.advance(id);
      advanced++;
    } catch (e) {
      deps.log(`[bridge/sweep] advance ${id} failed: ${errMsg(e)}`);
    }
  }
  return { created, advanced };
}
