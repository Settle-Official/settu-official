import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFeeBps } from "./fee-settings";

test("50 bps under a 100 bps cap is valid", () => {
  assert.equal(validateFeeBps(50, 100), null);
});

test("0 bps is valid so free promos are allowed", () => {
  assert.equal(validateFeeBps(0, 100), null);
});

test("above the cap is rejected with a message mentioning the cap", () => {
  const msg = validateFeeBps(101, 100);
  assert.equal(typeof msg, "string");
  assert.match(msg as string, /cap/);
});

test("negative fee is rejected", () => {
  assert.equal(typeof validateFeeBps(-1, 100), "string");
});

test("NaN is rejected", () => {
  assert.equal(typeof validateFeeBps(Number.NaN, 100), "string");
});

test("non-integer bps is rejected as not whole basis points", () => {
  const msg = validateFeeBps(12.5, 100);
  assert.equal(typeof msg, "string");
  assert.match(msg as string, /whole basis points/);
});
