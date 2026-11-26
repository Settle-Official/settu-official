import test from "node:test";
import assert from "node:assert/strict";
import { knownFiat } from "./known-fiat";

// The server writes destinationAmount "0" until settlement fills it in. "0" is
// not null, so a plain ?? keeps the placeholder and discards the real payout
// the local row captured at submit — which is why History showed a dash.

test("a real payout is kept verbatim", () => {
  assert.equal(knownFiat("22724"), "22724");
  assert.equal(knownFiat("12800.61"), "12800.61");
});

test("the server's unsettled placeholder reads as unknown", () => {
  assert.equal(knownFiat("0"), undefined);
  assert.equal(knownFiat("0.00"), undefined);
});

test("absent and malformed values read as unknown, not NaN", () => {
  assert.equal(knownFiat(undefined), undefined);
  assert.equal(knownFiat(""), undefined);
  assert.equal(knownFiat("not-a-number"), undefined);
});

test("a negative payout is not a payout", () => {
  assert.equal(knownFiat("-5"), undefined);
});
