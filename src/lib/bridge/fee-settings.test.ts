import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateFeeBps,
  parseStoredFeeBps,
  getBridgeFeeBps,
  DEFAULT_BRIDGE_FEE_BPS,
  DEFAULT_FEE_CAP_BPS,
} from "./fee-settings";

test("defaults are 30 standard, 60 fast; cap stays 100", () => {
  assert.deepEqual(DEFAULT_BRIDGE_FEE_BPS, { standard: 30, fast: 60 });
  assert.equal(DEFAULT_FEE_CAP_BPS, 100);
});

test("60 bps under a 100 bps cap is valid", () => {
  assert.equal(validateFeeBps(60, 100), null);
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

test("non-finite or negative lowestCapBps is rejected", () => {
  for (const cap of [Number.NaN, Infinity, -Infinity, -1]) {
    assert.equal(typeof validateFeeBps(10, cap), "string", String(cap));
  }
});

test("parseStoredFeeBps accepts integers in [0, 10000], numeric or string", () => {
  assert.equal(parseStoredFeeBps(45, "standard"), 45);
  assert.equal(parseStoredFeeBps("45", "fast"), 45);
  assert.equal(parseStoredFeeBps(0, "fast"), 0);
  assert.equal(parseStoredFeeBps(10000, "fast"), 10000);
});

test("parseStoredFeeBps falls back to the speed default on bad values", () => {
  for (const raw of ["abc", "", null, undefined, 12.5, -1, 10001, Number.NaN, "1e9"]) {
    assert.equal(parseStoredFeeBps(raw, "standard"), 30, String(raw));
    assert.equal(parseStoredFeeBps(raw, "fast"), 60, String(raw));
  }
});

test("getBridgeFeeBps returns the default when the stored value is abc", async () => {
  const keys: string[] = [];
  const read = async (key: string) => {
    keys.push(key);
    return "abc";
  };
  assert.equal(await getBridgeFeeBps("fast", read), 60);
  assert.deepEqual(keys, ["bridge:fee-bps:fast"]);
});
