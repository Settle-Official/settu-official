import test from "node:test";
import assert from "node:assert/strict";
import {
  orderRecoverable,
  isPayoutAlreadyResolved,
  decodeDepositForBurnData,
} from "./burn-backstop";
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

test("orderRecoverable: a non-CCTP-bridge EVM source (Base transfers directly) is out of this sweep's scope", () => {
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

// Real CCTP v2 DepositForBurn log data, taken verbatim from Base tx
// 0x121df6a70d1ed2173e50c50f59634572cb935255b88654b4cca3ceffb074c53e.
// 1 USDC burned, mint recipient 0x85d9a989…25bf1, destination domain 0.
const REAL_LOG_DATA =
  "0x00000000000000000000000000000000000000000000000000000000000f4240" +
  "00000000000000000000000085d9a989c9ae09a0a6172ca64a39535c15725bf1" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "00000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d" +
  "00000000000000000000000085d9a989c9ae09a0a6172ca64a39535c15725bf1" +
  "0000000000000000000000000000000000000000000000000000000000000082" +
  "00000000000000000000000000000000000000000000000000000000000000e0" +
  "0000000000000000000000000000000000000000000000000000000000000000";

test("decodes amount and mintRecipient from a real DepositForBurn log", () => {
  const decoded = decodeDepositForBurnData(REAL_LOG_DATA);
  assert.ok(decoded);
  assert.equal(decoded.amountAtomic, "1000000");
  assert.equal(
    decoded.mintRecipient,
    "0x85d9a989c9ae09a0a6172ca64a39535c15725bf1",
  );
});

test("tolerates data without the 0x prefix", () => {
  const decoded = decodeDepositForBurnData(REAL_LOG_DATA.slice(2));
  assert.equal(decoded?.amountAtomic, "1000000");
});

test("returns null when the blob is too short to hold both words", () => {
  assert.equal(decodeDepositForBurnData("0x"), null);
  assert.equal(decodeDepositForBurnData(REAL_LOG_DATA.slice(0, 66)), null);
});

test("mintRecipient is the low 20 bytes, so a bytes32 recipient narrows", () => {
  // A non-EVM mint recipient fills the full 32 bytes; only the low 20 are
  // comparable to an EVM address, which is what the sweep matches on.
  const wide =
    "0x00000000000000000000000000000000000000000000000000000000000f4240" +
    "ffffffffffffffffffffffff85d9a989c9ae09a0a6172ca64a39535c15725bf1";
  assert.equal(
    decodeDepositForBurnData(wide)?.mintRecipient,
    "0x85d9a989c9ae09a0a6172ca64a39535c15725bf1",
  );
});

test("a large amount survives as an exact decimal string", () => {
  // 1,000,000 USDC — well past Number.MAX_SAFE_INTEGER once atomic.
  const big =
    "0x000000000000000000000000000000000000000000000000000000e8d4a51000" +
    "00000000000000000000000085d9a989c9ae09a0a6172ca64a39535c15725bf1";
  assert.equal(decodeDepositForBurnData(big)?.amountAtomic, "1000000000000");
});
