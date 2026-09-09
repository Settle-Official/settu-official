import test from "node:test";
import assert from "node:assert/strict";
import { formatFiat, fiatSymbol } from "./currency";

test("NGN keeps the flush symbol and grouping the old formatters produced", () => {
  assert.equal(formatFiat(1234.5, "NGN"), "₦1,234.50");
  assert.equal(formatFiat("1234.5", "NGN"), "₦1,234.50");
  // Default currency is NGN, matching every implementation this replaced.
  assert.equal(formatFiat(10, undefined), "₦10.00");
});

test("word-like symbols get a separating space", () => {
  assert.equal(formatFiat(1234.5, "KES"), "KSh 1,234.50");
  assert.equal(formatFiat(1234.5, "UGX"), "USh 1,234.50");
  assert.equal(formatFiat(1234.5, "TZS"), "TSh 1,234.50");
});

test("an unknown currency falls back to its code, never a wrong symbol", () => {
  assert.equal(fiatSymbol("XOF"), "XOF");
  assert.equal(formatFiat(5, "XOF"), "XOF 5.00");
});

test("a caller-supplied symbol (Paycrest's) wins over the built-in map", () => {
  assert.equal(fiatSymbol("NGN", "N"), "N");
  assert.equal(formatFiat(5, "XOF", "CFA"), "CFA 5.00");
});

test("unparseable amounts render as the placeholder, not NaN", () => {
  for (const bad of [undefined, null, "", "abc", NaN, Infinity]) {
    assert.equal(formatFiat(bad as never, "NGN"), "--");
  }
});

test("zero is a real value, not a placeholder", () => {
  assert.equal(formatFiat(0, "NGN"), "₦0.00");
  assert.equal(formatFiat("0", "NGN"), "₦0.00");
});

test("currency codes are case-insensitive", () => {
  assert.equal(formatFiat(1, "ngn"), "₦1.00");
  assert.equal(fiatSymbol("kes"), "KSh");
});
