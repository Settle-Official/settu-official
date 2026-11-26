import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReceipt,
  maskAccount,
  shortenReference,
  type ReceiptSource,
} from "./receipt-data";

function source(overrides: Partial<ReceiptSource> = {}): ReceiptSource {
  return {
    kind: "offramp",
    usdc: 50,
    fiatAmount: "75000",
    currency: "NGN",
    status: "completed",
    timestamp: 1758528000000,
    bank: "GTBank",
    accountName: "Ada Obi",
    accountNumber: "0123456789",
    orderId: "ord-abc123",
    ...overrides,
  };
}

test("a receipt gets shared, so the account number is masked", () => {
  const field = buildReceipt(source()).fields.find((f) => f.label === "Account");
  assert.equal(field?.value, "••••6789");
});

test("masking never lengthens a short number into a fake one", () => {
  assert.equal(maskAccount("0789"), "0789");
  assert.equal(maskAccount("89"), "89");
});

test("the reference keeps both ends so it stays checkable", () => {
  const long = "0xabcdef0123456789abcdef0123456789abcdef01";
  const short = shortenReference(long);
  assert.ok(short.startsWith("0xabcdef01"), `head missing in ${short}`);
  assert.ok(short.endsWith(long.slice(-6)), `tail missing in ${short}`);
  assert.ok(short.length < long.length);
});

test("a short reference is left alone", () => {
  assert.equal(shortenReference("ord-abc123"), "ord-abc123");
});

test("the order id is preferred as the reference — support can look it up", () => {
  const receipt = buildReceipt(source({ orderId: "ord-1", txHash: "0xdead" }));
  assert.equal(receipt.reference, "ord-1");
});

test("the tx hash is the fallback when there is no order id", () => {
  const receipt = buildReceipt(source({ orderId: undefined, txHash: "0xdead" }));
  assert.equal(receipt.reference, "0xdead");
});

test("a missing payout shows a dash, never NaN or 0", () => {
  for (const fiatAmount of [undefined, "", "0", "not-a-number"]) {
    const receipt = buildReceipt(source({ fiatAmount }));
    const received = receipt.fields.find((f) => f.label === "Received");
    assert.equal(received?.value, "—", `fiatAmount ${JSON.stringify(fiatAmount)}`);
  }
});

test("the headline falls back to the USDC amount when no payout is known", () => {
  assert.equal(buildReceipt(source({ fiatAmount: undefined })).headline, "50.00 USDC");
});

test("fields a server-only row lacks are omitted, not shown blank", () => {
  const receipt = buildReceipt(
    source({ bank: undefined, accountName: undefined, accountNumber: undefined }),
  );
  const labels = receipt.fields.map((f) => f.label);
  assert.deepEqual(labels, ["Sent", "Received", "Date"]);
});

test("status wording is human, and an unsettled transfer never reads Completed", () => {
  assert.equal(buildReceipt(source({ status: "pending" })).status, "In progress");
  assert.equal(buildReceipt(source({ status: "failed" })).status, "Failed");
  assert.equal(buildReceipt(source({ status: "completed" })).status, "Completed");
});

test("an onramp is titled and labelled as a deposit", () => {
  const receipt = buildReceipt(source({ kind: "onramp" }));
  assert.equal(receipt.title, "Deposit receipt");
  assert.equal(receipt.fields[0].label, "Paid");
});
