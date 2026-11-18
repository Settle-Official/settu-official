import test from "node:test";
import assert from "node:assert/strict";

import {
  completedBridgeEntry,
  recordCompletedBridge,
  listCompletedBridgesByAddress,
  bridgeLifetimeTotals,
  addressKey,
  type LedgerStore,
  type CompletedBridge,
} from "./bridge-ledger";
import type { CctpTransferRecord } from "../cctp/cctp-store";

/** In-memory stand-in for the four Redis commands the ledger uses. */
function memStore(): LedgerStore & { kv: Map<string, string>; z: Map<string, Map<string, number>> } {
  const kv = new Map<string, string>();
  const z = new Map<string, Map<string, number>>();
  return {
    kv,
    z,
    async setNx(key, value) {
      if (kv.has(key)) return false;
      kv.set(key, value);
      return true;
    },
    async zadd(key, score, member) {
      if (!z.has(key)) z.set(key, new Map());
      z.get(key)!.set(member, score);
    },
    async zrevrange(key, start, stop) {
      const m = [...(z.get(key) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
      return m.slice(start, stop + 1);
    },
    async mget(keys) {
      return keys.map((k) => kv.get(k) ?? null);
    },
  };
}

function rec(over: Partial<CctpTransferRecord> = {}, bridge: Record<string, unknown> = {}): CctpTransferRecord {
  return {
    id: "0xabc",
    direction: "bridge",
    status: "completed",
    burnTxHash: "0xabc",
    mintTxHash: "0xmint",
    createdAt: 1_000,
    updatedAt: 2_000,
    bridge: {
      source: "base",
      dest: "solana",
      user: "0xA894a3B6fBf182D2D24Fff808B81De849cF7B41c",
      recipient: "7SWdeT5NiwDtbhEmZom9ZmbYWFE5vdsjwqHzgHF3jfyf",
      speed: "fast",
      sendAtomic: "5000000",
      settuFeeAtomic: "30000",
      receiveMinAtomic: "4960000",
      receivedAtomic: "4966825",
      ...bridge,
    },
    ...over,
  } as unknown as CctpTransferRecord;
}

test("a completed bridge becomes a permanent entry with both tx links and its amounts", () => {
  const e = completedBridgeEntry(rec(), 3_000);
  assert.deepEqual(e, {
    id: "0xabc",
    source: "base",
    dest: "solana",
    user: "0xA894a3B6fBf182D2D24Fff808B81De849cF7B41c",
    recipient: "7SWdeT5NiwDtbhEmZom9ZmbYWFE5vdsjwqHzgHF3jfyf",
    speed: "fast",
    sendAtomic: "5000000",
    settuFeeAtomic: "30000",
    receivedAtomic: "4966825",
    sourceTx: "0xabc",
    destTx: "0xmint",
    createdAt: 1_000,
    completedAt: 3_000,
  } satisfies CompletedBridge);
});

test("received falls back to the promised minimum when it wasn't read", () => {
  const e = completedBridgeEntry(rec({}, { receivedAtomic: undefined }), 3_000);
  assert.equal(e?.receivedAtomic, "4960000");
});

test("only completed bridges are entries", () => {
  assert.equal(completedBridgeEntry(rec({ status: "minting" }), 3_000), null);
  assert.equal(completedBridgeEntry(rec({ direction: "offramp" }), 3_000), null);
});

test("EVM addresses are matched case-insensitively; base58 and G-addresses keep their case", () => {
  assert.equal(addressKey("0xA894a3B6fBf182D2D24Fff808B81De849cF7B41c"), "bridge:done:by-address:0xa894a3b6fbf182d2d24fff808b81de849cf7b41c");
  assert.equal(addressKey("7SWdeT5NiwDtbhEmZom9ZmbYWFE5vdsjwqHzgHF3jfyf"), "bridge:done:by-address:7SWdeT5NiwDtbhEmZom9ZmbYWFE5vdsjwqHzgHF3jfyf");
});

test("recording is idempotent and indexes the sender and the recipient", async () => {
  const s = memStore();
  assert.equal(await recordCompletedBridge(rec(), s, 3_000), true);
  assert.equal(await recordCompletedBridge(rec(), s, 9_000), false);
  assert.equal(s.z.get("bridge:done:index")?.get("0xabc"), 3_000);
  const bySender = await listCompletedBridgesByAddress("0xa894a3b6fbf182d2d24fff808b81de849cf7b41c", 10, s);
  const byRecipient = await listCompletedBridgesByAddress("7SWdeT5NiwDtbhEmZom9ZmbYWFE5vdsjwqHzgHF3jfyf", 10, s);
  assert.equal(bySender.length, 1);
  assert.equal(byRecipient.length, 1);
  assert.equal(bySender[0].completedAt, 3_000);
});

test("a bridge to your own wallet on another chain is indexed once per address", async () => {
  const s = memStore();
  const same = "0xa894a3B6fBf182D2D24Fff808B81De849cF7B41c";
  await recordCompletedBridge(rec({}, { dest: "arbitrum", recipient: same }), s, 3_000);
  assert.equal((await listCompletedBridgesByAddress(same, 10, s)).length, 1);
});

test("lifetime totals sum what users sent, across every entry", async () => {
  const s = memStore();
  await recordCompletedBridge(rec({ id: "0x1" }, { sendAtomic: "5000000" }), s, 1);
  await recordCompletedBridge(rec({ id: "0x2" }, { sendAtomic: "2500000" }), s, 2);
  assert.deepEqual(await bridgeLifetimeTotals(s), { count: 2, sentAtomic: BigInt(7_500_000) });
});
