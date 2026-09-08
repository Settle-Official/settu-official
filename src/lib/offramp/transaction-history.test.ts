import test from "node:test";
import assert from "node:assert/strict";
import { buildTransactionRecord } from "./transaction-history";

test("buildTransactionRecord fills id, timestamps, and default status", () => {
  const record = buildTransactionRecord({
    id: "0xabc",
    sourceChain: "arbitrum",
    connectedAddress: "0x1111111111111111111111111111111111111a",
    amountUsdc: "10.5",
    destinationCurrency: "NGN",
    destinationAmount: "14300.00",
  });
  assert.equal(record.id, "0xabc");
  assert.equal(record.sourceChain, "arbitrum");
  assert.equal(record.status, "pending");
  assert.equal(typeof record.createdAt, "number");
  assert.equal(record.createdAt, record.updatedAt);
});

test("buildTransactionRecord accepts optional burn/mint hashes and order id", () => {
  const record = buildTransactionRecord({
    id: "0xabc",
    sourceChain: "base",
    connectedAddress: "0x1111111111111111111111111111111111111a",
    amountUsdc: "5",
    destinationCurrency: "NGN",
    destinationAmount: "6800.00",
    mintTxHash: "0xdef",
    paycrestOrderId: "order-123",
  });
  assert.equal(record.mintTxHash, "0xdef");
  assert.equal(record.burnTxHash, undefined);
  assert.equal(record.paycrestOrderId, "order-123");
});
