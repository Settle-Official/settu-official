import { test } from "node:test";
import assert from "node:assert/strict";
import { bpsToPercent, formatAtomic, parseAtomic, percentToBps } from "./admin-units";

test("percentToBps: percentages to whole basis points", () => {
  assert.deepEqual(percentToBps("0.3"), { ok: true, bps: 30 });
  assert.deepEqual(percentToBps("0.6"), { ok: true, bps: 60 });
  assert.deepEqual(percentToBps(" 1 "), { ok: true, bps: 100 });
  assert.deepEqual(percentToBps("0.05"), { ok: true, bps: 5 });
  assert.deepEqual(percentToBps("0"), { ok: true, bps: 0 });
});

test("percentToBps: non-whole-bps input is rejected with a clear message", () => {
  for (const bad of ["0.305", "0.001", "", "abc", "-0.3", "1e2", ".3."]) {
    const r = percentToBps(bad);
    assert.equal(r.ok, false, bad);
  }
  const r = percentToBps("0.305");
  assert.match(r.ok ? "" : r.error, /whole basis points/i);
});

test("bpsToPercent", () => {
  assert.equal(bpsToPercent(30), "0.3");
  assert.equal(bpsToPercent(60), "0.6");
  assert.equal(bpsToPercent(100), "1");
  assert.equal(bpsToPercent(5), "0.05");
  assert.equal(bpsToPercent(0), "0");
});

test("parseAtomic / formatAtomic round-trip, strict on excess decimals", () => {
  assert.deepEqual(parseAtomic("1.5", 6), { ok: true, value: BigInt(1_500_000) });
  assert.deepEqual(parseAtomic("0.0000001", 7), { ok: true, value: BigInt(1) });
  assert.equal(parseAtomic("0.0000001", 6).ok, false);
  assert.equal(parseAtomic("-1", 6).ok, false);
  assert.equal(parseAtomic("", 6).ok, false);
  assert.equal(formatAtomic("1500000", 6), "1.5");
  assert.equal(formatAtomic("1000000000000000000", 18), "1");
  assert.equal(formatAtomic("0", 7), "0");
  assert.equal(formatAtomic("123", 7), "0.0000123");
});
