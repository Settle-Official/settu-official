import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Hex } from "viem";
import { Address, nativeToScVal, xdr, StrKey } from "@stellar/stellar-sdk";
import type { CctpStatus, CctpTransferRecord } from "../cctp/cctp-store";
import { BridgeRegisterError, registerBridge } from "./bridge-store";
import type { BridgeChainKey } from "./chains";
import { readBridgedEvent } from "./read-source-event";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { SETTU_BRIDGE_IDL_JSON, settuBridgeCoder } from "../solana/settu-bridge";
import {
  CONFIRMATIONS,
  MAX_ADVANCES_PER_RUN,
  OVERLAP_BLOCKS,
  EVM_CHUNK_BLOCKS,
  FIRST_RUN_LOOKBACK,
  MAX_CHUNKS_PER_CHAIN,
  MAX_SOLANA_SIGNATURES_PER_RUN,
  SOLANA_PAGE_LIMIT,
  sweepBridgedEvents,
  type EvmSweepLog,
  type StellarRpcEvent,
  type SweepDeps,
} from "./event-sweep";

const BRIDGE = "0x1111111111111111111111111111111111111111";
// registerBridge -> readBridgedEvent checks the log came from bridgeContractFor("base").
process.env.BRIDGE_CONTRACT_BASE = BRIDGE;
const USER = "0x2222222222222222222222222222222222222222";
const SOL_PROGRAM = "3CGxb2E9ASpizQtoL8wykokiZ8BH19MXMWmgy17KQmD1";
process.env.BRIDGE_CONTRACT_SOLANA = SOL_PROGRAM;

/** Logs of a Solana bridge tx whose Bridged event is encoded with the IDL coder. */
function solanaBridgedLogs(): string[] {
  const disc = (SETTU_BRIDGE_IDL_JSON.events as unknown as { name: string; discriminator: number[] }[]).find(
    (e) => e.name === "Bridged",
  )!.discriminator;
  const body = settuBridgeCoder.types.encode("Bridged", {
    nonce: Array(32).fill(0xab),
    user: new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
    amount: new BN(1_000_000),
    settu_fee: new BN(5_000),
    network_fee: new BN(100),
    native_fee: new BN(0),
    dest_domain: 6,
    mint_recipient: [...Array(12).fill(0), ...Array(20).fill(0x33)],
    min_finality: 2000,
  });
  return [
    `Program ${SOL_PROGRAM} invoke [1]`,
    `Program data: ${Buffer.concat([Buffer.from(disc), body]).toString("base64")}`,
    `Program ${SOL_PROGRAM} success`,
  ];
}
const NONCE = ("0x" + "ab".repeat(32)) as Hex;
const MR = ("0x" + "00".repeat(12) + "33".repeat(20)) as Hex;
const TX = "0x" + "CD".repeat(32); // upper-case on purpose: ids are lower-cased
const item = parseAbiItem(
  "event Bridged(bytes32 indexed nonce, address indexed user, uint256 amount, uint256 settuFee, uint256 networkFee, uint256 nativeFee, uint32 destDomain, bytes32 mintRecipient, uint32 minFinality)",
);

function evmLog(tx = TX, address = BRIDGE): EvmSweepLog {
  return {
    address,
    transactionHash: tx,
    topics: encodeEventTopics({ abi: [item], eventName: "Bridged", args: { nonce: NONCE, user: USER } }) as Hex[],
    data: encodeAbiParameters(
      [
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
        { type: "uint32" }, { type: "bytes32" }, { type: "uint32" },
      ],
      [BigInt(1_000_000), BigInt(5_000), BigInt(100), BigInt(0), 6, MR, 2000],
    ),
  };
}

interface World {
  store: Map<string, CctpTransferRecord>;
  pending: Set<string>;
  cursors: Map<string, string>;
  calls: string[];
  advanced: string[];
  logs: string[];
  latest: Record<string, bigint>;
  logsFor: (chain: BridgeChainKey, from: bigint, to: bigint) => EvmSweepLog[];
  runs: number;
  indexed: Map<string, number>;
}

function world(): World {
  return {
    store: new Map(),
    pending: new Set(),
    cursors: new Map(),
    calls: [],
    advanced: [],
    logs: [],
    latest: {},
    logsFor: () => [],
    runs: 0,
    indexed: new Map(),
  };
}

/** Real registerBridge over an in-memory store; the event is read from the "receipt" (the same log). */
function sweepDeps(w: World, over: Partial<SweepDeps> = {}): SweepDeps {
  const storeDeps = {
    readEvent: (chain: BridgeChainKey, hash: string) =>
      readBridgedEvent(chain, hash, {
        evmLogs: async () => [evmLog(hash)],
        stellarEvents: async () => null,
        solanaLogs: async () => solanaBridgedLogs(),
      }),
    getQuote: async () => null,
    get: async (id: string) => w.store.get(id) ?? null,
    create: async (r: Omit<CctpTransferRecord, "createdAt" | "updatedAt" | "attempts">) => {
      w.calls.push(`create:${r.id}`);
      const f = { ...r, attempts: 0, createdAt: 1, updatedAt: 1 } as CctpTransferRecord;
      w.store.set(r.id, f);
      w.pending.add(r.id);
      return f;
    },
    now: () => 0,
  };
  return {
    chains: ["base"],
    contractFor: (c) => (c === "base" || c === "arbitrum" ? BRIDGE : null),
    getCursor: async (c) => w.cursors.get(c) ?? null,
    setCursor: async (c, v) => {
      w.calls.push(`cursor:${c}:${v}`);
      w.cursors.set(c, v);
    },
    evmLatestBlock: async (c) => w.latest[c] ?? BigInt(10_000),
    evmGetLogs: async (c, address, from, to) => {
      assert.equal(address, BRIDGE);
      assert.ok(to - from + BigInt(1) <= BigInt(EVM_CHUNK_BLOCKS), "chunk over 2000 blocks");
      w.calls.push(`logs:${c}:${from}-${to}`);
      return w.logsFor(c, from, to);
    },
    stellarLatestLedger: async () => 5_000,
    stellarGetEvents: async () => ({ events: [], latestLedger: 5_000 }),
    solanaSignatures: async () => [],
    getTransfer: async (id) => w.store.get(id) ?? null,
    register: async (chain, hash) => {
      w.calls.push(`register:${hash}`);
      await registerBridge(chain, hash, async () => {}, storeDeps);
    },
    listPending: async () => [...w.pending],
    nextAdvanceRun: async () => w.runs++,
    advance: async (id): Promise<CctpStatus> => {
      w.calls.push(`advance:${id}`);
      w.advanced.push(id);
      return w.store.get(id)!.status;
    },
    reindex: async (id, createdAt) => {
      w.calls.push(`reindex:${id}`);
      w.indexed.set(id, createdAt);
    },
    log: (m) => w.logs.push(m),
    ...over,
  };
}

test("bounds are as documented", () => {
  assert.equal(EVM_CHUNK_BLOCKS, 2000);
  assert.equal(FIRST_RUN_LOOKBACK, 2000);
  assert.ok(MAX_CHUNKS_PER_CHAIN >= 1 && MAX_CHUNKS_PER_CHAIN <= 5);
  assert.deepEqual(CONFIRMATIONS, { ethereum: 12, base: 30, optimism: 30, arbitrum: 240, polygon: 128, avalanche: 5 });
  assert.equal(OVERLAP_BLOCKS, 50);
});

test("Review focus 4: Bridged event with no Redis record is created and advanced; a second sweep creates it once", async () => {
  const w = world();
  w.logsFor = () => [evmLog()]; // the node returns the log on every scan (overlapping ranges)
  const d = sweepDeps(w);

  const r1 = await sweepBridgedEvents(d);
  const id = TX.toLowerCase();
  assert.deepEqual(r1, { created: 1, advanced: 1 });
  const rec = w.store.get(id)!;
  assert.equal(rec.direction, "bridge");
  assert.equal(rec.bridge!.source, "base");
  assert.equal(rec.bridge!.sendAtomic, "1000000");
  assert.equal(rec.status, "burned");
  assert.deepEqual(w.advanced, [id]);

  w.cursors.clear(); // force a full re-scan of the same range
  const r2 = await sweepBridgedEvents(d);
  assert.equal(r2.created, 0);
  assert.equal(w.calls.filter((c) => c.startsWith("create:")).length, 1);
  assert.equal(r2.advanced, 1); // still pending, driven again
});

test("same tx seen twice in one run registers once", async () => {
  const w = world();
  w.logsFor = () => [evmLog(), evmLog()];
  const r = await sweepBridgedEvents(sweepDeps(w));
  assert.equal(r.created, 1);
  assert.equal(w.calls.filter((c) => c.startsWith("register:")).length, 1);
});

test("first run (no cursor) starts at confirmedHead - 2000 and stops at the confirmed head", async () => {
  const w = world();
  w.latest.base = BigInt(10_000); // base CONFIRMATIONS 30 -> head 9970
  await sweepBridgedEvents(sweepDeps(w));
  const scans = w.calls.filter((c) => c.startsWith("logs:"));
  assert.deepEqual(scans, ["logs:base:7970-9969", "logs:base:9970-9970"]);
  assert.equal(w.cursors.get("base"), "9970");
});

test("resumes from cursor + 1, at most MAX_CHUNKS_PER_CHAIN chunks per run", async () => {
  const w = world();
  w.cursors.set("base", "1000");
  w.latest.base = BigInt(100_000);
  await sweepBridgedEvents(sweepDeps(w));
  const scans = w.calls.filter((c) => c.startsWith("logs:"));
  assert.equal(scans.length, MAX_CHUNKS_PER_CHAIN);
  assert.equal(scans[0], "logs:base:951-2950"); // overlap: cursor - 50 + 1
  assert.equal(w.cursors.get("base"), String(950 + MAX_CHUNKS_PER_CHAIN * 2000));
});

test("caught up: confirmed head <= cursor -> no scan, cursor untouched", async () => {
  for (const cursor of ["9970", "10000"]) {
    const w = world();
    w.cursors.set("base", cursor);
    w.latest.base = BigInt(10_000); // head 9970
    await sweepBridgedEvents(sweepDeps(w));
    assert.equal(w.calls.filter((c) => c.startsWith("logs:")).length, 0, cursor);
    assert.equal(w.calls.filter((c) => c.startsWith("cursor:")).length, 0, cursor);
  }
});

test("blocks within CONFIRMATIONS of the head are not scanned and the cursor doesn't pass them", async () => {
  const w = world();
  w.cursors.set("base", "9000");
  w.latest.base = BigInt(10_000); // head 9970
  const AT = BigInt(9_980); // event inside the unconfirmed tail
  w.logsFor = (_c, from, to) => (from <= AT && AT <= to ? [evmLog()] : []);
  const r1 = await sweepBridgedEvents(sweepDeps(w));
  assert.equal(r1.created, 0);
  for (const c of w.calls.filter((x) => x.startsWith("logs:"))) {
    assert.ok(BigInt(c.split("-")[1]) <= BigInt(9_970), c);
  }
  assert.equal(w.cursors.get("base"), "9970");

  w.latest.base = BigInt(10_100); // head 10070: now confirmed
  const r2 = await sweepBridgedEvents(sweepDeps(w));
  assert.equal(r2.created, 1);
  assert.equal(w.cursors.get("base"), "10070");
});

test("other chains use their own CONFIRMATIONS (arbitrum 240)", async () => {
  const w = world();
  w.cursors.set("arbitrum", "9000");
  w.latest.arbitrum = BigInt(10_000);
  await sweepBridgedEvents(sweepDeps(w, { chains: ["arbitrum"] }));
  assert.equal(w.cursors.get("arbitrum"), "9760");
});

test("overlap re-scan finds an event placed just below the old cursor", async () => {
  const w = world();
  w.cursors.set("base", "1000");
  w.latest.base = BigInt(1_100); // head 1070
  const AT = BigInt(990); // e.g. a lagging node returned [] for it last run
  w.logsFor = (_c, from, to) => (from <= AT && AT <= to ? [evmLog()] : []);
  const r = await sweepBridgedEvents(sweepDeps(w));
  assert.equal(r.created, 1);
  assert.equal(w.calls[0], "logs:base:951-1070");
});

test("an event in the overlap isn't registered twice across runs", async () => {
  const w = world();
  w.cursors.set("base", "1000");
  w.latest.base = BigInt(1_100); // head 1070
  const AT = BigInt(1_060);
  w.logsFor = (_c, from, to) => (from <= AT && AT <= to ? [evmLog()] : []);
  const r1 = await sweepBridgedEvents(sweepDeps(w));
  assert.equal(r1.created, 1);
  assert.equal(w.cursors.get("base"), "1070");
  w.latest.base = BigInt(1_200); // head 1170; run 2 scans 1021-1170, which includes 1060
  const r2 = await sweepBridgedEvents(sweepDeps(w));
  assert.ok(w.calls.includes("logs:base:1021-1170"));
  assert.equal(r2.created, 0);
  assert.equal(w.calls.filter((c) => c.startsWith("create:")).length, 1);
  assert.equal(w.calls.filter((c) => c.startsWith("register:")).length, 1);
});

test("cursor advances only after the chunk's events are processed", async () => {
  const w = world();
  w.cursors.set("base", "1000");
  w.latest.base = BigInt(3_000);
  w.logsFor = () => [evmLog()];
  await sweepBridgedEvents(sweepDeps(w));
  const reg = w.calls.indexOf(`register:${TX.toLowerCase()}`);
  const cur = w.calls.indexOf("cursor:base:2950");
  assert.ok(reg >= 0 && cur > reg, `register before cursor: ${w.calls.join(",")}`);
});

test("retryable registration failure: cursor NOT advanced, later chunks not scanned", async () => {
  const w = world();
  w.cursors.set("base", "1000");
  w.latest.base = BigInt(100_000);
  w.logsFor = (_c, from) => (from === BigInt(951) ? [evmLog()] : []);
  const d = sweepDeps(w, {
    register: async () => {
      throw new BridgeRegisterError("Transaction not confirmed yet.", 409, "not_indexed");
    },
  });
  const r = await sweepBridgedEvents(d);
  assert.equal(r.created, 0);
  assert.equal(w.cursors.get("base"), "1000");
  assert.equal(w.calls.filter((c) => c.startsWith("logs:")).length, 1);
  assert.ok(w.logs.some((l) => /base/.test(l)));
});

test("getLogs failure: cursor NOT advanced, other chains still swept", async () => {
  const w = world();
  w.cursors.set("base", "1000");
  w.cursors.set("arbitrum", "500");
  w.latest.arbitrum = BigInt(1_000); // head 760
  const d = sweepDeps(w, {
    chains: ["base", "arbitrum"],
    evmGetLogs: async (c, _a, from, to) => {
      if (c === "base") throw new Error("rpc down");
      w.calls.push(`logs:${c}:${from}-${to}`);
      return [];
    },
  });
  await sweepBridgedEvents(d);
  assert.equal(w.cursors.get("base"), "1000");
  assert.equal(w.cursors.get("arbitrum"), "760");
});

test("permanent (400) registration failure is logged and skipped; cursor advances", async () => {
  const w = world();
  w.cursors.set("base", "1000");
  w.latest.base = BigInt(2_000);
  w.logsFor = () => [evmLog()];
  const d = sweepDeps(w, {
    register: async () => {
      throw new BridgeRegisterError("invalid", 400, "invalid_event");
    },
  });
  await sweepBridgedEvents(d);
  assert.equal(w.cursors.get("base"), "1970");
  assert.ok(w.logs.some((l) => /invalid_event/.test(l)));
});

test("logs from other addresses / undecodable logs are ignored", async () => {
  const w = world();
  w.logsFor = () => [evmLog(TX, "0x9999999999999999999999999999999999999999"), { ...evmLog(), data: "0x" as Hex }];
  const r = await sweepBridgedEvents(sweepDeps(w));
  assert.equal(r.created, 0);
  assert.equal(w.calls.filter((c) => c.startsWith("register:")).length, 0);
});

test("chain with no contract configured is skipped and logged, not an error", async () => {
  const w = world();
  const d = sweepDeps(w, { chains: ["optimism"] });
  const r = await sweepBridgedEvents(d);
  assert.deepEqual(r, { created: 0, advanced: 0 });
  assert.equal(w.calls.filter((c) => c.startsWith("logs:")).length, 0);
  assert.ok(w.logs.some((l) => /optimism/.test(l) && /skip/i.test(l)));
});

// ---------------------------------------------------------------- Solana

/** Distinct base58 signatures; sig(n) for n in 0..57 (order = time order in the tests). */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const sig = (n: number) => `${"5".repeat(85)}${B58[Math.floor(n / 58) % 58]}${B58[n % 58]}`;

/**
 * A fake Solana chain: `history` is every signature for the program, oldest
 * first. getSignaturesForAddress semantics: newest first, strictly older than
 * `before`, strictly newer than `until`, at most `limit`.
 */
function solanaWorld(w: World, history: { signature: string; err?: unknown }[]) {
  const pages: { before?: string; until?: string; limit: number }[] = [];
  const solanaSignatures: SweepDeps["solanaSignatures"] = async (program, opts) => {
    assert.equal(program, SOL_PROGRAM);
    assert.ok(opts.limit <= 1000);
    pages.push({ ...opts });
    const newestFirst = [...history].reverse();
    let start = 0;
    if (opts.before) start = newestFirst.findIndex((h) => h.signature === opts.before) + 1;
    let end = newestFirst.length;
    if (opts.until) {
      const u = newestFirst.findIndex((h) => h.signature === opts.until);
      if (u >= 0) end = u;
    }
    return newestFirst.slice(start, end).slice(0, opts.limit).map((h) => ({ signature: h.signature, err: h.err ?? null }));
  };
  return { pages, solanaSignatures };
}

function solanaSweepDeps(w: World, history: { signature: string; err?: unknown }[], over: Partial<SweepDeps> = {}) {
  const sw = solanaWorld(w, history);
  const d = sweepDeps(w, {
    chains: ["solana"],
    contractFor: (c) => (c === "solana" ? SOL_PROGRAM : null),
    solanaSignatures: sw.solanaSignatures,
    ...over,
  });
  return { d, pages: sw.pages };
}

test("Solana: an unknown signature is registered once across two runs; cursor moves only after processing", async () => {
  const w = world();
  const history = [{ signature: sig(1) }];
  const { d, pages } = solanaSweepDeps(w, history, {
    setCursor: async (c, v) => {
      // By the time the cursor moves, the signature has been registered.
      assert.ok(w.store.has(sig(1)), "cursor set before the signature was processed");
      w.calls.push(`cursor:${c}:${v}`);
      w.cursors.set(c, v);
    },
  });
  const r1 = await sweepBridgedEvents(d);
  assert.equal(r1.created, 1);
  const rec = w.store.get(sig(1))!;
  assert.equal(rec.id, sig(1), "case-sensitive id kept");
  assert.equal(rec.bridge!.source, "solana");
  assert.equal(rec.sourceDomain, 5);
  assert.equal(w.cursors.get("solana"), sig(1));
  assert.equal(pages[0].until, undefined, "first run: latest page only");

  const r2 = await sweepBridgedEvents(d);
  assert.equal(r2.created, 0);
  assert.equal(pages[1].until, sig(1));
  assert.equal(w.calls.filter((c) => c.startsWith("create:")).length, 1);
  assert.equal(w.calls.filter((c) => c.startsWith("register:")).length, 1);
});

test("Solana: processes oldest-first, pages through `until` newest-first, cursor = newest processed", async () => {
  const w = world();
  const history = Array.from({ length: 2500 }, (_, i) => ({ signature: sig(i) }));
  w.cursors.set("solana", sig(9)); // processed up to sig(9)
  const order: string[] = [];
  const { d, pages } = solanaSweepDeps(w, history, {
    getTransfer: async () => ({ direction: "bridge" }) as CctpTransferRecord, // all known: cheap
    register: async () => assert.fail("known signatures are not re-registered"),
  });
  const getTransfer = d.getTransfer;
  d.getTransfer = async (id) => {
    order.push(id);
    return getTransfer(id);
  };
  d.listPending = async () => [];
  await sweepBridgedEvents(d);
  assert.deepEqual(pages.map((p) => p.until), [sig(9), sig(9), sig(9)]);
  assert.equal(pages[0].before, undefined);
  assert.equal(pages[1].before, sig(1500));
  assert.equal(order.length, Math.min(2490, MAX_SOLANA_SIGNATURES_PER_RUN));
  assert.equal(order[0], sig(10), "oldest first");
  const newest = order[order.length - 1];
  assert.equal(w.cursors.get("solana"), newest);
  assert.equal(newest, sig(9 + MAX_SOLANA_SIGNATURES_PER_RUN));
});

test("Solana: first run (no cursor) takes only the latest page", async () => {
  const w = world();
  const history = Array.from({ length: 1500 }, (_, i) => ({ signature: sig(i) }));
  const { d, pages } = solanaSweepDeps(w, history, {
    getTransfer: async () => ({ direction: "bridge" }) as CctpTransferRecord,
  });
  d.listPending = async () => [];
  await sweepBridgedEvents(d);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].limit, SOLANA_PAGE_LIMIT);
  assert.equal(SOLANA_PAGE_LIMIT, 1000);
  // Oldest of the latest page is sig(500).
  assert.equal(w.cursors.get("solana"), sig(499 + MAX_SOLANA_SIGNATURES_PER_RUN));
});

test("Solana: failed txs are skipped without a registration; cursor still passes them", async () => {
  const w = world();
  w.cursors.set("solana", sig(0));
  const history = [{ signature: sig(0) }, { signature: sig(1), err: { InstructionError: [1, "x"] } }];
  const { d } = solanaSweepDeps(w, history);
  const r = await sweepBridgedEvents(d);
  assert.equal(r.created, 0);
  assert.equal(w.calls.filter((c) => c.startsWith("register:")).length, 0);
  assert.equal(w.cursors.get("solana"), sig(1));
});

test("Solana: a retryable failure keeps the cursor at the last processed signature", async () => {
  const w = world();
  w.cursors.set("solana", sig(0));
  const history = [0, 1, 2, 3].map((n) => ({ signature: sig(n) }));
  const { d } = solanaSweepDeps(w, history, {
    register: async (chain, hash) => {
      w.calls.push(`register:${hash}`);
      if (hash === sig(2)) throw new BridgeRegisterError("rpc", 503, "unavailable");
    },
  });
  await sweepBridgedEvents(d);
  assert.equal(w.cursors.get("solana"), sig(1));
  assert.deepEqual(w.calls.filter((c) => c.startsWith("register:")), [`register:${sig(1)}`, `register:${sig(2)}`]);
  assert.ok(w.logs.some((l) => /solana: stopped this run/.test(l)));
});

test("Solana: signature listing failure leaves the cursor untouched", async () => {
  const w = world();
  w.cursors.set("solana", sig(0));
  const { d } = solanaSweepDeps(w, [], {
    solanaSignatures: async () => {
      throw new Error("429");
    },
  });
  await sweepBridgedEvents(d);
  assert.equal(w.cursors.get("solana"), sig(0));
  assert.ok(!w.calls.some((c) => c.startsWith("cursor:")));
});

test("advance pass: only non-final bridge records; offramp/final ones untouched; errors don't stop the pass", async () => {
  const w = world();
  const base = { sourceDomain: 6, destDomain: 7, burnTxHash: "h", mintRecipient: "m", attempts: 0, createdAt: 1, updatedAt: 1 };
  w.store.set("off", { ...base, id: "off", direction: "offramp", status: "attesting" } as CctpTransferRecord);
  w.store.set("done", { ...base, id: "done", direction: "bridge", status: "completed" } as CctpTransferRecord);
  w.store.set("b1", { ...base, id: "b1", direction: "bridge", status: "attesting" } as CctpTransferRecord);
  w.store.set("b2", { ...base, id: "b2", direction: "bridge", status: "burned" } as CctpTransferRecord);
  for (const k of ["off", "done", "b1", "missing", "b2"]) w.pending.add(k);
  const d = sweepDeps(w, {
    chains: [],
    advance: async (id) => {
      w.advanced.push(id);
      if (id === "b1") throw new Error("boom");
      return "attesting";
    },
  });
  const r = await sweepBridgedEvents(d);
  assert.deepEqual(w.advanced, ["b1", "b2"]);
  assert.equal(r.advanced, 1);
});

// --- Stellar ---

const CID = StrKey.encodeContract(Buffer.alloc(32, 7));
const SUSER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 9));
const STX = "ef".repeat(32);

function stellarRpcEvent(contractId = CID, over: Partial<StellarRpcEvent> = {}): StellarRpcEvent {
  const data = xdr.ScVal.scvVec([
    new Address(SUSER).toScVal(),
    nativeToScVal(BigInt(10_000_000), { type: "i128" }),
    nativeToScVal(BigInt(50_000), { type: "i128" }),
    nativeToScVal(BigInt(1_000), { type: "i128" }),
    nativeToScVal(BigInt(0), { type: "i128" }),
    nativeToScVal(6, { type: "u32" }),
    xdr.ScVal.scvBytes(Buffer.from(MR.slice(2), "hex")),
    nativeToScVal(1000, { type: "u32" }),
  ]);
  return {
    type: "contract",
    id: "0000000001-0000000001",
    ledger: 4_000,
    contractId,
    txHash: STX,
    inSuccessfulContractCall: true,
    topic: [xdr.ScVal.scvSymbol("bridged").toXDR("base64"), xdr.ScVal.scvBytes(Buffer.from(NONCE.slice(2), "hex")).toXDR("base64")],
    value: data.toXDR("base64"),
    ...over,
  };
}

test("Stellar: first run starts at latestLedger - 2000, registers unknown events, stores the RPC cursor after processing", async () => {
  const w = world();
  const reqs: unknown[] = [];
  const d = sweepDeps(w, {
    chains: ["stellar"],
    contractFor: (c) => (c === "stellar" ? CID : null),
    stellarLatestLedger: async () => 5_000,
    stellarGetEvents: async (req) => {
      reqs.push(req);
      w.calls.push("events");
      return { events: [stellarRpcEvent()], latestLedger: 5_000, cursor: "c-1" };
    },
    register: async (_c, hash) => {
      w.calls.push(`register:${hash}`);
      w.store.set(hash, { id: hash, direction: "bridge", status: "burned" } as CctpTransferRecord);
    },
  });
  const r = await sweepBridgedEvents(d);
  assert.equal(r.created, 1);
  assert.deepEqual((reqs[0] as { startLedger: number }).startLedger, 3_000);
  assert.equal((reqs[0] as { contractId: string }).contractId, CID);
  assert.ok(w.calls.indexOf(`register:${STX}`) < w.calls.indexOf("cursor:stellar:c-1"));
  assert.equal(w.cursors.get("stellar"), "c-1");
});

test("Stellar: resumes from stored cursor; failed-call and foreign events ignored", async () => {
  const w = world();
  w.cursors.set("stellar", "c-1");
  const reqs: { cursor?: string; startLedger?: number }[] = [];
  const d = sweepDeps(w, {
    chains: ["stellar"],
    contractFor: (c) => (c === "stellar" ? CID : null),
    stellarGetEvents: async (req) => {
      reqs.push(req);
      return {
        events: [
          stellarRpcEvent(CID, { inSuccessfulContractCall: false }),
          stellarRpcEvent(StrKey.encodeContract(Buffer.alloc(32, 8))),
        ],
        latestLedger: 5_000,
        cursor: "c-2",
      };
    },
    register: async () => {
      throw new Error("should not register");
    },
  });
  const r = await sweepBridgedEvents(d);
  assert.equal(r.created, 0);
  assert.equal(reqs[0].cursor, "c-1");
  assert.equal(reqs[0].startLedger, undefined);
  assert.equal(w.cursors.get("stellar"), "c-2");
});

test("Stellar: retryable registration failure leaves the cursor", async () => {
  const w = world();
  w.cursors.set("stellar", "c-1");
  const d = sweepDeps(w, {
    chains: ["stellar"],
    contractFor: (c) => (c === "stellar" ? CID : null),
    stellarGetEvents: async () => ({ events: [stellarRpcEvent()], latestLedger: 5_000, cursor: "c-2" }),
    register: async () => {
      throw new Error("rpc down");
    },
  });
  await sweepBridgedEvents(d);
  assert.equal(w.cursors.get("stellar"), "c-1");
});

test("malformed contract config is logged as an error for that chain only", async () => {
  const w = world();
  w.cursors.set("arbitrum", "500");
  w.latest.arbitrum = BigInt(1_000);
  const d = sweepDeps(w, {
    chains: ["base", "arbitrum"],
    contractFor: (c) => {
      if (c === "base") throw new Error("BRIDGE_CONTRACT_BASE must be a 0x EVM address");
      return BRIDGE;
    },
  });
  await sweepBridgedEvents(d);
  assert.ok(w.logs.some((l) => /base/.test(l) && /0x EVM address/.test(l)));
  assert.equal(w.cursors.get("arbitrum"), "760");
});

test("advance pass rotates its start so no bridge starves behind MAX_ADVANCES_PER_RUN", async () => {
  const w = world();
  const base = { sourceDomain: 6, destDomain: 7, burnTxHash: "h", mintRecipient: "m", attempts: 0, createdAt: 1, updatedAt: 1 };
  const ids = Array.from({ length: 30 }, (_, i) => `b${String(i).padStart(2, "0")}`);
  for (const id of [...ids].reverse()) {
    w.store.set(id, { ...base, id, direction: "bridge", status: "attesting" } as CctpTransferRecord);
    w.pending.add(id);
  }
  const d = sweepDeps(w, { chains: [], advance: async (id) => { w.advanced.push(id); return "attesting"; } });

  const r1 = await sweepBridgedEvents(d);
  const run1 = [...w.advanced];
  w.advanced.length = 0;
  const r2 = await sweepBridgedEvents(d);
  const run2 = [...w.advanced];

  assert.equal(r1.advanced, MAX_ADVANCES_PER_RUN);
  assert.equal(r2.advanced, MAX_ADVANCES_PER_RUN);
  assert.deepEqual(run1, ids.slice(0, 25));
  for (const starved of ids.slice(25)) assert.ok(run2.includes(starved), starved);
  assert.equal(new Set([...run1, ...run2]).size, 30);
});

test("advance offset unavailable: falls back to start 0, pass still runs", async () => {
  const w = world();
  w.store.set("b1", { id: "b1", direction: "bridge", status: "burned" } as CctpTransferRecord);
  w.pending.add("b1");
  const d = sweepDeps(w, { chains: [], nextAdvanceRun: async () => { throw new Error("redis down"); } });
  const r = await sweepBridgedEvents(d);
  assert.equal(r.advanced, 1);
});

test("sweep advance pass repairs a missing explorer index entry (idempotent)", async () => {
  const w = world();
  const id = "0x" + "ee".repeat(32);
  w.store.set(id, {
    id, direction: "bridge", sourceDomain: 6, destDomain: 3, burnTxHash: id, mintRecipient: MR,
    status: "attested", attempts: 0, createdAt: 777, updatedAt: 777,
    bridge: { source: "base", dest: "arbitrum", user: USER, speed: "fast", quoteNonce: "n", sendAtomic: "1", settuFeeAtomic: "0", networkFeeAtomic: "0", fastFeeMaxAtomic: "0", receiveMinAtomic: "1" },
  } as CctpTransferRecord);
  w.pending.add(id);
  assert.equal(w.indexed.has(id), false, "index write was lost");
  await sweepBridgedEvents(sweepDeps(w));
  assert.equal(w.indexed.get(id), 777);
  await sweepBridgedEvents(sweepDeps(w));
  assert.equal(w.indexed.size, 1);
});
