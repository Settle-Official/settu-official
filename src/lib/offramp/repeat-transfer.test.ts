import test from "node:test";
import assert from "node:assert/strict";
import { canRepeat, _parseForTests as parse } from "./repeat-transfer";

const valid = JSON.stringify({
  amountUsdc: "50",
  currency: "NGN",
  institution: "GTBINGLA",
  accountIdentifier: "0123456789",
  accountName: "Ada Obi",
  sourceChain: "base",
});

test("a complete payload round trips", () => {
  const parsed = parse(valid);
  assert.equal(parsed?.amountUsdc, "50");
  assert.equal(parsed?.accountIdentifier, "0123456789");
  assert.equal(parsed?.sourceChain, "base");
});

test("sourceChain is optional and stays absent rather than undefined", () => {
  const parsed = parse(JSON.stringify({ ...JSON.parse(valid), sourceChain: undefined }));
  assert.ok(parsed);
  assert.equal("sourceChain" in parsed!, false);
});

test("a payload missing any required field is rejected", () => {
  for (const field of [
    "amountUsdc",
    "currency",
    "institution",
    "accountIdentifier",
    "accountName",
  ]) {
    const partial = { ...JSON.parse(valid), [field]: undefined };
    assert.equal(parse(JSON.stringify(partial)), null, `should reject missing ${field}`);
  }
});

test("empty strings are rejected, not treated as present", () => {
  const blank = { ...JSON.parse(valid), accountName: "" };
  assert.equal(parse(JSON.stringify(blank)), null);
});

test("a non-string field is rejected", () => {
  // Guards the form against a tampered entry injecting an object or number.
  const wrong = { ...JSON.parse(valid), accountIdentifier: 123456789 };
  assert.equal(parse(JSON.stringify(wrong)), null);
});

test("malformed JSON is rejected rather than thrown", () => {
  assert.equal(parse("{not json"), null);
  assert.equal(parse(""), null);
});

test("repeat is offered only when the bank details are known", () => {
  const complete = {
    kind: "offramp" as const,
    bank: "GTB",
    accountName: "Ada Obi",
    accountNumber: "0123456789",
  };
  assert.equal(canRepeat(complete), true);

  // A row read from another device has no beneficiary — Redis never stored it.
  assert.equal(canRepeat({ ...complete, bank: undefined }), false);
  assert.equal(canRepeat({ ...complete, accountNumber: undefined }), false);
  assert.equal(canRepeat({ ...complete, accountName: undefined }), false);
});

test("an onramp is never repeatable through the offramp form", () => {
  assert.equal(
    canRepeat({
      kind: "onramp",
      bank: "GTB",
      accountName: "Ada Obi",
      accountNumber: "0123456789",
    }),
    false,
  );
});
