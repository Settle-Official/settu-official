import test from "node:test";
import assert from "node:assert/strict";
import { orderRecoverable, isPayoutAlreadyResolved } from "./burn-backstop";
import type { OrderMeta } from "./order-meta-store";

const BASE_META: OrderMeta = {
  institution: "GTBINGLA",
  accountIdentifier: "0123456789",
  accountName: "JOHN DOE",
  currency: "NGN",
  amountUsdc: 10,
  rate: 1360,
  payoutValue: 13600,
  senderAddress: "GALC4XJL55YPA7WLS3VDK3IOZDQ4LF5ZXO422EJZ34MPFI44NPXZOQCR",
  receiveAddress: "0xFa1cd6958FF585CED1dcc589c5A8d608fA3786C5",
  sourceChain: "stellar",
  createdAt: Date.now() - 15 * 60_000, // 15 min old — inside the window
};

test("orderRecoverable: within the grace-to-max-age window is recoverable", () => {
  assert.equal(orderRecoverable(BASE_META), true);
});

test("orderRecoverable: too young (still likely mid-flow) is not recoverable", () => {
  assert.equal(
    orderRecoverable({ ...BASE_META, createdAt: Date.now() - 60_000 }),
    false,
  );
});

test("orderRecoverable: too old (manual-triage territory) is not recoverable", () => {
  assert.equal(
    orderRecoverable({ ...BASE_META, createdAt: Date.now() - 25 * 60 * 60_000 }),
    false,
  );
});

test("orderRecoverable: a non-Stellar source is out of this sweep's scope", () => {
  assert.equal(orderRecoverable({ ...BASE_META, sourceChain: "base" }), false);
});

test("orderRecoverable: missing sender/receive address is not recoverable", () => {
  assert.equal(orderRecoverable({ ...BASE_META, senderAddress: undefined }), false);
  assert.equal(orderRecoverable({ ...BASE_META, receiveAddress: undefined }), false);
});

test("orderRecoverable: null meta is not recoverable", () => {
  assert.equal(orderRecoverable(null), false);
});

test("isPayoutAlreadyResolved: settled and refunded mean nothing left to do", () => {
  assert.equal(isPayoutAlreadyResolved("settled"), true);
  assert.equal(isPayoutAlreadyResolved("refunded"), true);
});

test("isPayoutAlreadyResolved: 'expired' is NOT treated as resolved — this is the confirmed regression", () => {
  // A burn that succeeded but was never registered leaves Paycrest's order
  // sitting at "expired" (they never saw a deposit). Treating expired as
  // "nothing to recover" — the old isTerminal() check did exactly this —
  // permanently orphans the exact case this sweep exists to catch.
  assert.equal(isPayoutAlreadyResolved("expired"), false);
});

test("isPayoutAlreadyResolved: an in-flight or unknown status is not resolved", () => {
  assert.equal(isPayoutAlreadyResolved("pending"), false);
  assert.equal(isPayoutAlreadyResolved("deposited"), false);
  assert.equal(isPayoutAlreadyResolved(undefined), false);
});
