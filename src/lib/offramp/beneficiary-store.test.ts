import test from "node:test";
import assert from "node:assert/strict";
import { toWire, fromWire, isComplete, type Beneficiary } from "./beneficiary-store";

const sample: Beneficiary = {
  institution: "GTBINGLA",
  accountIdentifier: "0123456789",
  accountName: "Ada Obi",
  currency: "NGN",
};

test("the wire shape round trips", () => {
  assert.deepEqual(fromWire(toWire(sample)), sample);
});

test("camelCase maps to the snake_case the API expects", () => {
  const wire = toWire(sample);
  assert.equal(wire.account_identifier, "0123456789");
  assert.equal(wire.account_name, "Ada Obi");
});

test("an incomplete beneficiary is never sent — the API requires every field", () => {
  assert.equal(isComplete(sample), true);
  for (const field of [
    "institution",
    "accountIdentifier",
    "accountName",
    "currency",
  ] as const) {
    assert.equal(
      isComplete({ ...sample, [field]: "" }),
      false,
      `should reject blank ${field}`,
    );
    assert.equal(
      isComplete({ ...sample, [field]: undefined }),
      false,
      `should reject missing ${field}`,
    );
  }
});

test("null and undefined meta are handled, not thrown on", () => {
  assert.equal(isComplete(null), false);
  assert.equal(isComplete(undefined), false);
  assert.equal(isComplete({}), false);
});
