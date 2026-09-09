import test from "node:test";
import assert from "node:assert/strict";
import {
  mapPaycrestStatus,
  normalizePayoutStatus,
} from "./paycrest-adapter";

test("normalizePayoutStatus passes through known bare statuses incl. fulfilled", () => {
  assert.equal(normalizePayoutStatus("fulfilled"), "fulfilled");
  assert.equal(normalizePayoutStatus("validated"), "validated");
  assert.equal(normalizePayoutStatus("settled"), "settled");
});

test("normalizePayoutStatus is 'unknown' for junk / missing", () => {
  assert.equal(normalizePayoutStatus(undefined), "unknown");
  assert.equal(normalizePayoutStatus(""), "unknown");
  assert.equal(normalizePayoutStatus("processing"), "unknown");
});

test("mapPaycrestStatus recognises the fulfilled event name", () => {
  assert.equal(mapPaycrestStatus("payment_order.fulfilled"), "fulfilled");
  assert.equal(mapPaycrestStatus("payment_order.validated"), "validated");
  assert.equal(mapPaycrestStatus("payment_order.nonsense"), "unknown");
});
