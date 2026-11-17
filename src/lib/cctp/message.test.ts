import test from "node:test";
import assert from "node:assert/strict";
import { parseCctpMessage } from "./message";
import { buildV2Message } from "./message.test-helper";

test("parseCctpMessage reads header and burn body fields at the V2 offsets", () => {
  const m = parseCctpMessage(
    buildV2Message({
      sourceDomain: 3,
      destDomain: 5,
      nonce: "cd".repeat(32),
      finalityThresholdExecuted: 2000,
      burnToken: "ee".repeat(32),
      mintRecipient: "ff".repeat(32),
      amount: BigInt(1_234_567),
      feeExecuted: BigInt(89),
    }),
  );
  assert.equal(m.sourceDomain, 3);
  assert.equal(m.destDomain, 5);
  assert.equal(m.nonce.toString("hex"), "cd".repeat(32));
  assert.equal(m.finalityThresholdExecuted, 2000);
  assert.equal(m.burnToken.toString("hex"), "ee".repeat(32));
  assert.equal(m.mintRecipient.toString("hex"), "ff".repeat(32));
  assert.equal(m.amount, BigInt(1_234_567));
  assert.equal(m.feeExecuted, BigInt(89));
});

test("parseCctpMessage rejects a message too short for a burn body", () => {
  assert.throws(() => parseCctpMessage("0x00000001"));
});
