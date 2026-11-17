import test from "node:test";
import assert from "node:assert/strict";

process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
process.env.UPSTASH_REDIS_REST_TOKEN = "tok";

const sent: { url: string; body: unknown }[] = [];
globalThis.fetch = (async (url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  sent.push({ url: String(url), body });
  const n = Array.isArray(body) ? body.length : 1;
  const res = Array.from({ length: n }, () => ({ result: 1 }));
  return new Response(JSON.stringify(Array.isArray(body) ? res : res[0]), { status: 200 });
}) as never;

const WEEK = 7 * 24 * 60 * 60 * 1000;
const cmds = (b: unknown) => (b as unknown[][]).map((c) => c.map(String));

test("create writes record + pending + index and trims, in ONE multi/exec", async () => {
  const { createCctpTransfer } = await import("./cctp-store");
  sent.length = 0;
  const before = Date.now();
  const rec = await createCctpTransfer({
    id: "0xabc", direction: "bridge", sourceDomain: 6, destDomain: 3, burnTxHash: "0xabc",
    mintRecipient: "0x00", status: "burned",
  });
  assert.equal(sent.length, 1, "a single request");
  assert.match(sent[0].url, /multi-exec/);
  const c = cmds(sent[0].body);
  assert.deepEqual(c.map((x) => x[0].toLowerCase()), ["set", "sadd", "zadd", "zremrangebyscore"]);
  assert.deepEqual(c[2].slice(1), ["bridge:index", String(rec.createdAt), "0xabc"]);
  assert.equal(c[3][2], "-inf");
  const cutoff = Number(c[3][3].slice(1));
  assert.ok(c[3][3].startsWith("("));
  assert.ok(cutoff >= before - WEEK - 5 && cutoff <= Date.now() - WEEK + 5, "cutoff = now - 7d");
});

test("indexBridgeTransfer is an idempotent ZADD + trim (sweep repair)", async () => {
  const { indexBridgeTransfer } = await import("./cctp-store");
  sent.length = 0;
  await indexBridgeTransfer("0xdef", 12345, 1_000_000_000_000);
  const c = cmds(sent[0].body);
  assert.deepEqual(c[0].slice(0, 4).map((x, i) => (i === 0 ? x.toLowerCase() : x)), ["zadd", "bridge:index", "12345", "0xdef"]);
  assert.deepEqual(c[1].map((x, i) => (i === 0 ? x.toLowerCase() : x)), [
    "zremrangebyscore", "bridge:index", "-inf", `(${1_000_000_000_000 - WEEK}`,
  ]);
});
