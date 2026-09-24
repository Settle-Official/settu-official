import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { isValidSignature } from "./client";

const SECRET = "test-app-secret";
const BODY = JSON.stringify({ entry: [{ id: "1" }] });

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("accepts a signature Meta would have produced", async (t) => {
  process.env.WHATSAPP_APP_SECRET = SECRET;
  t.after(() => delete process.env.WHATSAPP_APP_SECRET);

  assert.equal(await isValidSignature(BODY, sign(BODY)), true);
});

test("rejects a body that was altered after signing", async (t) => {
  process.env.WHATSAPP_APP_SECRET = SECRET;
  t.after(() => delete process.env.WHATSAPP_APP_SECRET);

  const header = sign(BODY);
  assert.equal(await isValidSignature(BODY + " ", header), false);
});

test("rejects a signature made with someone else's secret", async (t) => {
  process.env.WHATSAPP_APP_SECRET = SECRET;
  t.after(() => delete process.env.WHATSAPP_APP_SECRET);

  assert.equal(await isValidSignature(BODY, sign(BODY, "not-our-secret")), false);
});

test("rejects a missing or malformed header", async (t) => {
  process.env.WHATSAPP_APP_SECRET = SECRET;
  t.after(() => delete process.env.WHATSAPP_APP_SECRET);

  assert.equal(await isValidSignature(BODY, null), false);
  assert.equal(await isValidSignature(BODY, "deadbeef"), false);
  assert.equal(await isValidSignature(BODY, "sha256="), false);
});

test("trusts nothing when no app secret is configured", async () => {
  delete process.env.WHATSAPP_APP_SECRET;
  // Unverifiable must mean untrusted, not "allow through until configured".
  assert.equal(await isValidSignature(BODY, sign(BODY)), false);
});
