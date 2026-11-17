import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBreakdown } from "./quote-math";
import { computeAtomicFee } from "../cctp/iris-client";

const base = {
  source: "base" as const,
  dest: "arbitrum" as const,
  amount: "100",
  speed: "standard" as const,
  feeBps: 30,
  fastFeeBps: 1.3,
  networkFeeMode: "usdc" as const,
  networkFeeAtomic: BigInt(630000),
  nativeFeeAtomic: BigInt(210000000000000),
};
const fast = { ...base, speed: "fast" as const, feeBps: 60 };

test("standard, 100 USDC, 30 bps, usdc mode", () => {
  const b = computeBreakdown(base);
  assert.ok(!("error" in b));
  assert.equal(b.sendAtomic, BigInt(100_000_000));
  assert.equal(b.settuFeeShownAtomic, BigInt(300000));
  assert.equal(b.settuFeeAtomic, BigInt(300000));
  assert.equal(b.fastFeeMaxAtomic, BigInt(0));
  assert.equal(b.networkFeeAtomic, BigInt(630000));
  assert.equal(b.nativeFeeAtomic, BigInt(0));
  assert.equal(b.burnAtomic, BigInt(99_070_000));
  assert.equal(b.receiveAtomic, BigInt(99_070_000));
  assert.equal(b.receiveIsMinimum, false);
  assert.equal(b.adjustedAmount, undefined);
});

test("fast, 100 USDC, 60 bps, usdc mode: Circle fee comes out of the 0.6%", () => {
  const b = computeBreakdown(fast);
  assert.ok(!("error" in b));
  assert.equal(b.settuFeeShownAtomic, BigInt(600000));
  assert.equal(b.fastFeeMaxAtomic, computeAtomicFee(1.3, BigInt(100_000_000)));
  assert.equal(b.fastFeeMaxAtomic, BigInt(13000));
  assert.equal(b.settuFeeAtomic, BigInt(587000));
  assert.equal(b.burnAtomic, BigInt(98_783_000));
  assert.equal(b.receiveAtomic, BigInt(98_770_000));
  assert.equal(b.receiveAtomic, b.burnAtomic - b.fastFeeMaxAtomic);
  assert.equal(b.receiveIsMinimum, true);
});

test("native mode: network fee 0, native passed through", () => {
  const b = computeBreakdown({ ...fast, networkFeeMode: "native" });
  assert.ok(!("error" in b));
  assert.equal(b.networkFeeAtomic, BigInt(0));
  assert.equal(b.nativeFeeAtomic, BigInt(210000000000000));
  assert.equal(b.receiveAtomic, BigInt(99_400_000));
  assert.equal(b.burnAtomic, BigInt(100_000_000 - 587000));
});

test("fast fee above the Settu fee is fast_unavailable", () => {
  const b = computeBreakdown({ ...fast, fastFeeBps: 100 });
  assert.ok("error" in b);
  assert.equal(b.code, "fast_unavailable");
});

test("stellar rounds down to 6 decimals and computes on adjusted value", () => {
  const b = computeBreakdown({ ...base, source: "stellar", amount: "10.1234567" });
  assert.ok(!("error" in b));
  assert.equal(b.adjustedAmount, "10.123456");
  assert.equal(b.sendAtomic, BigInt(10_123_456));
});

test("stellar dropping only a zero digit has no adjustedAmount", () => {
  const b = computeBreakdown({ ...base, source: "stellar", amount: "10.1234560" });
  assert.ok(!("error" in b));
  assert.equal(b.adjustedAmount, undefined);
  assert.equal(b.sendAtomic, BigInt(10_123_456));
});

test("stellar with <=6 decimals has no adjustedAmount", () => {
  const b = computeBreakdown({ ...base, source: "stellar", amount: "10.5" });
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

test("receive <= 0 is too small", () => {
  const b = computeBreakdown({ ...base, amount: "0.630001", feeBps: 10000 });
  assert.ok("error" in b);
  assert.match(b.error, /too small/);
});

test("negative network or native fee is rejected", () => {
  const a = computeBreakdown({ ...base, networkFeeAtomic: BigInt(-1) });
  assert.ok("error" in a);
  const n = computeBreakdown({ ...base, networkFeeMode: "native", nativeFeeAtomic: BigInt(-1) });
  assert.ok("error" in n);
});

test("feeBps 0 gives settu 0", () => {
  const b = computeBreakdown({ ...base, feeBps: 0 });
  assert.ok(!("error" in b));
  assert.equal(b.settuFeeAtomic, BigInt(0));
});

test("settu fee rounds up", () => {
  const b = computeBreakdown({ ...base, amount: "1.000001", feeBps: 50, networkFeeAtomic: BigInt(0) });
  assert.ok(!("error" in b));
  assert.equal(b.settuFeeShownAtomic, BigInt(5001)); // 5000.005 -> 5001
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
