import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTransactionRecord,
  toWire,
  fromWire,
  type OfframpTransactionRecord,
} from "./transaction-history";

// The wire shape is the contract with the Rust backend. These assert both
// directions so a field rename fails here rather than silently dropping data.

function sample(
  overrides: Partial<OfframpTransactionRecord> = {},
): OfframpTransactionRecord {
  return {
    ...buildTransactionRecord({
      id: "0xburn",
      sourceChain: "base",
      connectedAddress: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      amountUsdc: "10.5",
      destinationCurrency: "NGN",
      destinationAmount: "14300.00",
      paycrestOrderId: "ord-1",
    }),
    ...overrides,
  };
}

test("a fully populated record survives the round trip", () => {
  const record = sample({
    burnTxHash: "0xburn",
    mintTxHash: "0xmint",
    status: "completed",
  });
  assert.deepEqual(fromWire(toWire(record)), record);
});

test("optional fields stay absent rather than becoming undefined keys", () => {
  const record = sample({ paycrestOrderId: undefined });
  const wire = toWire(record);
  assert.equal("burn_tx_hash" in wire, false);
  assert.equal("mint_tx_hash" in wire, false);
  assert.equal("paycrest_order_id" in wire, false);
});

test("camelCase maps to the snake_case the API expects", () => {
  const wire = toWire(sample({ mintTxHash: "0xmint" }));
  assert.equal(wire.source_chain, "base");
  assert.equal(wire.connected_address, "0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
  assert.equal(wire.amount_usdc, "10.5");
  assert.equal(wire.destination_currency, "NGN");
  assert.equal(wire.mint_tx_hash, "0xmint");
  assert.equal(wire.paycrest_order_id, "ord-1");
});

test("an empty destinationAmount becomes a valid zero, not a 400", () => {
  // The API validates this as a decimal, and "" would be rejected outright.
  assert.equal(toWire(sample({ destinationAmount: "" })).destination_amount, "0");
  assert.equal(toWire(sample({ destinationAmount: "0" })).destination_amount, "0");
});

test("timestamps stay epoch milliseconds across the wire", () => {
  const record = sample({ createdAt: 1758528000000, updatedAt: 1758528009999 });
  const wire = toWire(record);
  assert.equal(wire.created_at, 1758528000000);
  assert.equal(wire.updated_at, 1758528009999);
  assert.equal(fromWire(wire).createdAt, 1758528000000);
});

test("amount scale is preserved verbatim, not reformatted", () => {
  for (const amount of ["50.00", "10.5", "0.000001"]) {
    assert.equal(fromWire(toWire(sample({ amountUsdc: amount }))).amountUsdc, amount);
  }
});

test("every source chain round trips, including solana", () => {
  const chains = ["stellar", "solana", "base", "arbitrum", "polygon"] as const;
  for (const sourceChain of chains) {
    assert.equal(fromWire(toWire(sample({ sourceChain }))).sourceChain, sourceChain);
  }
});
