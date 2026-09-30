import test from "node:test";
import assert from "node:assert/strict";
import { transfersAwaitingBurn } from "./resume-burn";
import type { Transaction } from "../transaction-storage";

const NOW = 1_790_700_000_000;
const HOUR = 60 * 60_000;

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: "tx",
    timestamp: NOW - HOUR,
    userAddress: "FbgrhPZ6oACLnRLKtsdDgwWFfQW8CALJLiHsEuDCyzs4",
    amount: "5",
    currency: "NGN",
    payoutOrderId: "order",
    beneficiary: {
      institution: "PalmPay",
      accountIdentifier: "7068895714",
      accountName: "A B",
      currency: "NGN",
    },
    status: "pending",
    ...overrides,
  };
}

test("a recent pending offramp with an order but no burn needs a check", () => {
  assert.deepEqual(
    transfersAwaitingBurn([tx({ id: "a" })], NOW).map((t) => t.id),
    ["a"],
  );
});

test("a failed one is checked too: its wallet reply may have timed out after the burn landed", () => {
  assert.equal(transfersAwaitingBurn([tx({ status: "failed" })], NOW).length, 1);
});

test("skips transfers that already have a burn, finished ones, onramps, and ones with no order", () => {
  const skipped = [
    tx({ id: "burned", stellarTxHash: "abc" }),
    tx({ id: "done", status: "completed" }),
    tx({ id: "onramp", kind: "onramp" }),
    tx({ id: "no-order", payoutOrderId: undefined }),
  ];
  assert.deepEqual(transfersAwaitingBurn(skipped, NOW), []);
});

test("skips anything older than a day: that is the sweep's and the admin console's job", () => {
  assert.deepEqual(
    transfersAwaitingBurn([tx({ timestamp: NOW - 25 * HOUR })], NOW),
    [],
  );
});

test("checks at most the three most recent, newest first", () => {
  const many = [1, 2, 3, 4, 5].map((n) =>
    tx({ id: `t${n}`, timestamp: NOW - n * HOUR }),
  );
  assert.deepEqual(
    transfersAwaitingBurn(many, NOW).map((t) => t.id),
    ["t1", "t2", "t3"],
  );
});
