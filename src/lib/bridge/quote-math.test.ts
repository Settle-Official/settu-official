import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBreakdown } from "./quote-math";

const base = {
  source: "base" as const,
  dest: "arbitrum" as const,
  amount: "100",
  speed: "fast" as const,
  feeBps: 50,
  fastFeeBps: 1.3,
  networkFeeAtomic: BigInt(630000),
};

test("100 USDC fast breakdown", () => {
  const b = computeBreakdown(base);
  assert.ok(!("error" in b));
  assert.equal(b.sendAtomic, BigInt(100_000_000));
  assert.equal(b.settuFeeAtomic, BigInt(500000));
  assert.equal(b.burnAtomic, BigInt(98_870_000));
  assert.ok(b.fastFeeMaxAtomic >= BigInt(12853));
  assert.equal(b.receiveAtomic, b.burnAtomic - b.fastFeeMaxAtomic);
  assert.equal(b.totalFeeAtomic, BigInt(1_130_000));
  assert.equal(b.receiveIsMinimum, true);
  assert.equal(b.adjustedAmount, undefined);
});

test("standard has no fast fee", () => {
  const b = computeBreakdown({ ...base, speed: "standard" });
  assert.ok(!("error" in b));
  assert.equal(b.fastFeeMaxAtomic, BigInt(0));
  assert.equal(b.receiveAtomic, b.burnAtomic);
  assert.equal(b.receiveIsMinimum, false);
});

test("stellar rounds down to 6 decimals and computes on adjusted value", () => {
  const b = computeBreakdown({ ...base, source: "stellar", amount: "10.1234567", speed: "standard" });
  assert.ok(!("error" in b));
  assert.equal(b.adjustedAmount, "10.123456");
  assert.equal(b.sendAtomic, BigInt(10_123_456));
});

test("stellar with <=6 decimals has no adjustedAmount", () => {
  const b = computeBreakdown({ ...base, source: "stellar", amount: "10.5", speed: "standard" });
  assert.ok(!("error" in b));
  assert.equal(b.adjustedAmount, undefined);
  assert.equal(b.sendAtomic, BigInt(10_500_000));
});

test("fees >= amount is too small", () => {
  for (const amount of ["0.5", "0.63", "0.6"]) {
    const b = computeBreakdown({ ...base, amount });
    assert.ok("error" in b, amount);
    assert.match(b.error, /too small/);
  }
});

test("fast fee eating the whole burn is too small", () => {
  const b = computeBreakdown({ ...base, amount: "0.630001", feeBps: 0, fastFeeBps: 10000 });
  assert.ok("error" in b);
  assert.match(b.error, /too small/);
});

test("feeBps 0 gives settu 0", () => {
  const b = computeBreakdown({ ...base, feeBps: 0 });
  assert.ok(!("error" in b));
  assert.equal(b.settuFeeAtomic, BigInt(0));
});

test("settu fee rounds up", () => {
  const b = computeBreakdown({ ...base, amount: "1.000001", feeBps: 50, networkFeeAtomic: BigInt(0), speed: "standard" });
  assert.ok(!("error" in b));
  assert.equal(b.settuFeeAtomic, BigInt(5001)); // 5000.005 -> 5001
});

test("rejects bad amounts", () => {
  for (const amount of ["", "abc", "-1", "0", "0.0", "1e3", "1.1234567", ".5", "1.", " 1"]) {
    const b = computeBreakdown({ ...base, amount });
    assert.ok("error" in b, `"${amount}"`);
  }
  const s = computeBreakdown({ ...base, source: "stellar", amount: "1.12345678" });
  assert.ok("error" in s);
});

test("stellar amount that rounds to zero is rejected", () => {
  const b = computeBreakdown({ ...base, source: "stellar", amount: "0.0000001" });
  assert.ok("error" in b);
});
