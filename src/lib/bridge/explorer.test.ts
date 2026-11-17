import test from "node:test";
import assert from "node:assert/strict";
import type { CctpStatus, CctpTransferRecord } from "../cctp/cctp-store";
import {
  bridgeTotals,
  listBridges,
  STUCK_AFTER_MS,
  TOTALS_SCAN_CAP,
  type ExplorerDeps,
} from "./explorer";
import { explorerGet } from "./explorer-handler";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function rec(
  id: string,
  ageMs: number,
  over: Partial<CctpTransferRecord> = {},
  meta: Partial<NonNullable<CctpTransferRecord["bridge"]>> = {},
): CctpTransferRecord {
  const createdAt = NOW - ageMs;
  return {
    id,
    direction: "bridge",
    sourceDomain: 6,
    destDomain: 3,
    burnTxHash: id,
    mintRecipient: "0x" + "00".repeat(32),
    status: "completed" as CctpStatus,
    attempts: 1,
    createdAt,
    updatedAt: createdAt,
    bridge: {
      source: "base",
      dest: "arbitrum",
      user: "0xUSER",
      recipient: "0xRECIP",
      speed: "fast",
      quoteNonce: "n",
      sendAtomic: "1000000",
      settuFeeAtomic: "3000",
      networkFeeAtomic: "100",
      nativeFeeAtomic: "7",
      fastFeeMaxAtomic: "0",
      receiveMinAtomic: "990000",
      ...meta,
    },
    ...over,
  };
}

function deps(records: CctpTransferRecord[], calls: { range: number; mget: number[] } = { range: 0, mget: [] }): ExplorerDeps {
  const sorted = [...records].sort((a, b) => b.createdAt - a.createdAt);
  return {
    now: () => NOW,
    async range(max, min, count) {
      calls.range++;
      const hi = max.startsWith("(") ? Number(max.slice(1)) - 0.5 : max === "+inf" ? Infinity : Number(max);
      const lo = min === "-inf" ? -Infinity : Number(min);
      return sorted.filter((r) => r.createdAt <= hi && r.createdAt >= lo).slice(0, count).map((r) => r.id);
    },
    async mget(ids) {
      calls.mget.push(ids.length);
      return ids.map((i) => records.find((r) => r.id === i) ?? null);
    },
  };
}

test("index is read newest-first", async () => {
  const d = deps([rec("a", 3 * HOUR), rec("c", 1 * HOUR), rec("b", 2 * HOUR)]);
  const { rows } = await listBridges({}, d);
  assert.deepEqual(rows.map((r) => r.id), ["c", "b", "a"]);
});

test("each filter narrows", async () => {
  const d = deps([
    rec("a", HOUR, {}, { source: "base", dest: "arbitrum", speed: "fast" }),
    rec("b", 2 * HOUR, { status: "failed" }, { source: "arbitrum", dest: "base", speed: "standard" }),
    rec("c", 40 * HOUR, { status: "attesting" }, { source: "base", dest: "base", speed: "standard" }),
  ]);
  const ids = async (f: Parameters<typeof listBridges>[0]) => (await listBridges(f, d)).rows.map((r) => r.id);
  assert.deepEqual(await ids({ status: "failed" }), ["b"]);
  assert.deepEqual(await ids({ status: "verifying" }), ["c"]);
  assert.deepEqual(await ids({ source: "base" }), ["a", "c"]);
  assert.deepEqual(await ids({ dest: "base" }), ["b", "c"]);
  assert.deepEqual(await ids({ speed: "standard" }), ["b", "c"]);
  assert.deepEqual(await ids({ from: NOW - 3 * HOUR }), ["a", "b"]);
  assert.deepEqual(await ids({ to: NOW - 30 * HOUR }), ["c"]);
  assert.deepEqual(await ids({ source: "base", speed: "standard" }), ["c"]);
});

test("q finds by source tx hash, user and recipient (case-insensitive prefix)", async () => {
  const d = deps([
    rec("0xaaa111", HOUR, {}, { recipient: "0xRecipientOne", user: "0xUserOne" }),
    rec("0xbbb222", 2 * HOUR, {}, { recipient: "0xRecipientTwo", user: "0xUserTwo" }),
  ]);
  const ids = async (q: string) => (await listBridges({ q }, d)).rows.map((r) => r.id);
  assert.deepEqual(await ids("0xaaa111"), ["0xaaa111"]);
  assert.deepEqual(await ids("0xbbb"), ["0xbbb222"]);
  assert.deepEqual(await ids("0xrecipienttwo"), ["0xbbb222"]);
  assert.deepEqual(await ids("0xUserOne"), ["0xaaa111"]);
  assert.deepEqual(await ids("nomatch"), []);
});

test("stuck flips at 30 minutes and only for non-final bridges", async () => {
  const d = deps([
    rec("fresh", 0, { status: "attested", updatedAt: NOW - (STUCK_AFTER_MS - 1) }),
    rec("old", HOUR, { status: "attested", updatedAt: NOW - (STUCK_AFTER_MS + 1) }),
    rec("done", HOUR, { status: "completed", updatedAt: NOW - 5 * HOUR }),
    rec("dead", HOUR, { status: "failed", updatedAt: NOW - 5 * HOUR }),
  ]);
  const by = Object.fromEntries((await listBridges({}, d)).rows.map((r) => [r.id, r.stuck]));
  assert.deepEqual(by, { fresh: false, old: true, done: false, dead: false });
  assert.deepEqual((await listBridges({ status: "stuck" }, d)).rows.map((r) => r.id), ["old"]);
});

test("rows carry addresses, fees and the status view", async () => {
  const d = deps([rec("a", HOUR, { lastError: "boom", attempts: 3 }, { recipientIsTokenAccount: true })]);
  const [r] = (await listBridges({}, d)).rows;
  assert.equal(r.user, "0xUSER");
  assert.equal(r.recipient, "0xRECIP");
  assert.equal(r.recipientIsTokenAccount, true);
  assert.equal(r.speed, "fast");
  assert.equal(r.settuFeeAtomic, "3000");
  assert.equal(r.nativeFeeAtomic, "7");
  assert.equal(r.attempts, 3);
  assert.equal(r.lastError, "boom");
  assert.equal(r.status, "completed");
});

test("paging: nextCursor continues without repeats; skips expired records", async () => {
  const recs = [rec("a", 1 * HOUR), rec("b", 2 * HOUR), rec("c", 3 * HOUR), rec("d", 4 * HOUR)];
  const d = deps(recs);
  const p1 = await listBridges({ limit: 2 }, d);
  assert.deepEqual(p1.rows.map((r) => r.id), ["a", "b"]);
  assert.ok(p1.nextCursor);
  const p2 = await listBridges({ limit: 2, cursor: p1.nextCursor }, d);
  assert.deepEqual(p2.rows.map((r) => r.id), ["c", "d"]);
  const gone = deps([rec("a", HOUR), rec("c", 3 * HOUR)]);
  const orig = gone.mget;
  gone.mget = async (ids) => (await orig(ids)).map((r, i) => (ids[i] === "a" ? null : r));
  assert.deepEqual((await listBridges({}, gone)).rows.map((r) => r.id), ["c"]);
});

test("list costs one range + one mget for an unfiltered page", async () => {
  const calls = { range: 0, mget: [] as number[] };
  const d = deps([rec("a", HOUR), rec("b", 2 * HOUR)], calls);
  await listBridges({ limit: 50 }, d);
  assert.equal(calls.range, 1);
  assert.deepEqual(calls.mget, [2]);
});

test("totals sum only the window", async () => {
  const d = deps([
    rec("in1", 1 * HOUR),
    rec("in2", 2 * HOUR, { status: "failed" }, { sendAtomic: "2000000" }),
    rec("in3", 3 * HOUR, { status: "attested", updatedAt: NOW - 3 * HOUR }),
    rec("in4", 4 * HOUR, { status: "burned", updatedAt: NOW - 1 * MIN }),
    rec("out", 30 * HOUR),
  ]);
  const t = await bridgeTotals("24h", d);
  assert.equal(t.count, 4);
  assert.equal(t.volumeAtomic, String(1_000_000 + 2_000_000 + 1_000_000 + 1_000_000));
  assert.equal(t.feesAtomic, String(4 * 3100));
  assert.equal(t.inProgress, 1);
  assert.equal(t.failedOrStuck, 2);
  const w = await bridgeTotals("7d", deps([rec("x", 30 * HOUR), rec("y", 8 * 24 * HOUR)]));
  assert.equal(w.count, 1);
});

test("totals: MGET pages <= 100, scan hard cap, 30s cache", async () => {
  const many = Array.from({ length: TOTALS_SCAN_CAP + 500 }, (_, i) => rec(`t${i}`, 1000 + i));
  const calls = { range: 0, mget: [] as number[] };
  const d = deps(many, calls);
  d.cache = new Map();
  const t = await bridgeTotals("24h", d);
  assert.equal(t.count, TOTALS_SCAN_CAP);
  assert.equal(t.truncated, true);
  assert.ok(calls.mget.every((n) => n <= 100));
  const before = calls.range;
  await bridgeTotals("24h", d);
  assert.equal(calls.range, before, "cached within 30s");
});

test("route: 401 without admin auth, before any read", async () => {
  let touched = false;
  const req = new Request("http://x/api/admin/bridge/explorer") as never;
  const r = await explorerGet(req, {
    isAdmin: () => false,
    list: async () => {
      touched = true;
      return { rows: [] };
    },
  });
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { error: "Unauthorized", code: "unauthorized" });
  assert.equal(touched, false);
});

test("route: lists, totals, and rejects bad params", async () => {
  const req = (qs: string) => new Request(`http://x/api/admin/bridge/explorer${qs}`) as never;
  const o = {
    isAdmin: () => true,
    list: async () => ({ rows: [] }),
    totals: async (w: "24h" | "7d") => ({ count: w === "24h" ? 1 : 7 }) as never,
  };
  assert.equal((await explorerGet(req("?limit=5&status=failed"), o)).status, 200);
  assert.deepEqual((await explorerGet(req("?totals=7d"), o)).body, { totals: { count: 7 } });
  assert.equal((await explorerGet(req("?totals=1y"), o)).status, 400);
  assert.equal((await explorerGet(req("?status=bogus"), o)).status, 400);
  assert.equal((await explorerGet(req("?limit=abc"), o)).status, 400);
});
