import test from "node:test";
import assert from "node:assert/strict";

import { appendWaitlistRow, sheetsConfigured } from "./sheets";
import { SHEET_HEADERS } from "./schema";

process.env.WAITLIST_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/TEST/exec";
process.env.WAITLIST_SHEET_SECRET = "s3cret";

const reply = (status: number, body: string) =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

test("configured once both env vars are set", () => {
  assert.equal(sheetsConfigured(), true);
});

test("posts the secret, headers and row to the webhook", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  await appendWaitlistRow(["a", "b"], f);
  assert.equal(calls.length, 1);
  const [sent] = calls;
  assert.equal(sent.url, process.env.WAITLIST_SHEET_WEBHOOK_URL);
  assert.equal(sent.body.secret, "s3cret");
  assert.deepEqual(sent.body.headers, [...SHEET_HEADERS]);
  assert.deepEqual(sent.body.row, ["a", "b"]);
});

test("throws when the script rejects the request", async () => {
  await assert.rejects(appendWaitlistRow(["x"], reply(200, JSON.stringify({ ok: false, error: "bad secret" }))), /bad secret/);
});

test("throws on an HTML error page or a non-2xx", async () => {
  await assert.rejects(appendWaitlistRow(["x"], reply(200, "<html>Sign in</html>")), /webhook failed/);
  await assert.rejects(appendWaitlistRow(["x"], reply(500, "oops")), /500/);
});
