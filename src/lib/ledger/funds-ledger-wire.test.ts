import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLedgerEntry,
  toWire,
  fromWire,
  type FundsLedgerEntry,
} from "./funds-ledger";

// The wire shape is the contract with the Rust backend. These assert both
// directions so a field rename fails here rather than silently dropping data.

test("a fully populated entry survives the round trip", () => {
  const entry = buildLedgerEntry({
    direction: "onramp",
    wallet: "base_hot_wallet",
    chain: "base",
    asset: "USDC",
    amount: "50.00",
    txHash: "0xabc",
    orderId: "order-1",
  });
  assert.deepEqual(fromWire(toWire(entry)), entry);
});

test("optional fields stay absent rather than becoming undefined keys", () => {
  const entry = buildLedgerEntry({
    direction: "offramp",
    chain: "stellar",
    asset: "USDC",
    amount: "10.5",
    txHash: "stellar-hash",
  });
  const wire = toWire(entry);
  assert.equal("wallet" in wire, false);
  assert.equal("order_id" in wire, false);
  assert.deepEqual(fromWire(wire), entry);
});

test("camelCase maps to the snake_case the API expects", () => {
  const entry = buildLedgerEntry({
    direction: "offramp",
    chain: "arbitrum",
    asset: "USDC",
    amount: "1",
    txHash: "0xfeed",
    orderId: "ord-2",
  });
  const wire = toWire(entry);
  assert.equal(wire.tx_hash, entry.txHash);
  assert.equal(wire.order_id, entry.orderId);
  assert.equal(wire.recorded_at, entry.recordedAt);
});

test("recordedAt stays epoch milliseconds across the wire", () => {
  const entry: FundsLedgerEntry = {
    id: "11111111-1111-1111-1111-111111111111",
    direction: "onramp",
    chain: "base",
    asset: "USDC",
    amount: "1",
    txHash: "0x1",
    recordedAt: 1758528000000,
  };
  assert.equal(toWire(entry).recorded_at, 1758528000000);
  assert.equal(typeof fromWire(toWire(entry)).recordedAt, "number");
});

test("amount scale is preserved verbatim, not reformatted", () => {
  for (const amount of ["50.00", "10.5", "0.000001", "1000000"]) {
    const entry = buildLedgerEntry({
      direction: "offramp",
      chain: "base",
      asset: "USDC",
      amount,
      txHash: "0x1",
    });
    assert.equal(fromWire(toWire(entry)).amount, amount);
  }
});
