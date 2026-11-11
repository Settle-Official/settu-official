import test from "node:test";
import assert from "node:assert/strict";
import { isPayableAccountIdentifier, normalizeAccountIdentifier } from "./validation";

test("normalizeAccountIdentifier: an 11-digit Nigerian phone-style number loses its leading 0", () => {
  assert.equal(normalizeAccountIdentifier("OPAYNGPC", "09027657685"), "9027657685");
  assert.equal(normalizeAccountIdentifier("opayngpc", " 0902 765-7685 "), "9027657685");
});

test("normalizeAccountIdentifier: a 10-digit NUBAN is left alone, even with a leading 0", () => {
  assert.equal(normalizeAccountIdentifier("OPAYNGPC", "9027657685"), "9027657685");
  assert.equal(normalizeAccountIdentifier("GTBINGLA", "0123456789"), "0123456789");
});

test("normalizeAccountIdentifier: other countries keep their leading 0", () => {
  assert.equal(normalizeAccountIdentifier("SAFAKEPC", "07123456789"), "07123456789");
});

test("isPayableAccountIdentifier: Nigerian accounts must be 10 digits; others only pass the shape check", () => {
  assert.equal(isPayableAccountIdentifier("OPAYNGPC", "9027657685"), true);
  assert.equal(isPayableAccountIdentifier("OPAYNGPC", "902765768"), false);
  assert.equal(isPayableAccountIdentifier("OPAYNGPC", "19027657685"), false);
  assert.equal(isPayableAccountIdentifier("SAFAKEPC", "0712345678901"), true);
  assert.equal(isPayableAccountIdentifier("SAFAKEPC", "abc"), false);
});
