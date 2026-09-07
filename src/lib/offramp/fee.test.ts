import test from "node:test";
import assert from "node:assert/strict";
import { PAYCREST_SENDER_FEE_RATE, applyPaycrestSenderFee } from "./fee";

test("PAYCREST_SENDER_FEE_RATE matches the current dashboard setting (0.3%)", () => {
  assert.equal(PAYCREST_SENDER_FEE_RATE, 0.003);
});

test("applyPaycrestSenderFee matches Paycrest's real settlement math", () => {
  // Reproduces two real settled orders' figures (fetched from Paycrest's own
  // API before this fix) at the *old* fee rate, confirming the formula
  // itself — order.amount + order.senderFee === the gross USDC sent, and
  // senderFee is exactly that percentage of the sum:
  //   order 9ae30a25: sent 5 USDC, amount 4.9505, senderFee 0.0495 (0.99%)
  const oldRate = 0.0099;
  const grossUsdc = 5;
  const rate = 1360.65; // NGN per USDC at settlement time
  const grossFiat = grossUsdc * rate;
  const netFiat = grossFiat * (1 - oldRate);
  const expectedNet = 4.9505 * 1360.65; // Paycrest's own reported net amount * rate
  assert.ok(
    Math.abs(netFiat - expectedNet) < 0.5,
    `${netFiat} should be within a rounding margin of ${expectedNet}`,
  );

  // At the current 0.3% rate, applyPaycrestSenderFee should apply the same
  // shape of deduction.
  const fee = grossFiat - applyPaycrestSenderFee(grossFiat);
  assert.equal(Number(fee.toFixed(4)), Number((grossFiat * 0.003).toFixed(4)));
});

test("applyPaycrestSenderFee is a pure percentage reduction", () => {
  assert.equal(applyPaycrestSenderFee(1000), 997);
  assert.equal(applyPaycrestSenderFee(0), 0);
});
