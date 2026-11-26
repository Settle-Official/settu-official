import test from "node:test";
import assert from "node:assert/strict";

import { SHEET_HEADERS, toSheetRow, validateWaitlist } from "./schema";

const good = {
  email: "  Dev@Example.COM ",
  name: "Ada",
  company: "Acme Pay",
  need: "offramp",
  building: "wallet",
  markets: ["NGN", "KES", "ZZZ", "NGN"],
  chains: ["stellar", "base", 42],
  volume: "10k-100k",
  useCase: "Payouts for our users",
  heardFrom: "X",
};

test("accepts a complete entry and normalises it", () => {
  const r = validateWaitlist(good);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.entry.email, "dev@example.com");
  assert.deepEqual(r.entry.markets, ["NGN", "KES"]); // unknown + duplicate dropped
  assert.deepEqual(r.entry.chains, ["stellar", "base"]); // non-string dropped
});

test("reports each missing required field", () => {
  const r = validateWaitlist({ email: "nope", markets: "NGN" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(Object.keys(r.errors).sort(), ["building", "email", "name", "need"]);
});

test("rejects option values that are not on the list", () => {
  const r = validateWaitlist({ ...good, need: "everything", volume: "lots" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.need && r.errors.volume);
});

test("tolerates garbage input without throwing", () => {
  for (const v of [null, undefined, 42, "x", []]) assert.equal(validateWaitlist(v).ok, false);
});

test("sheet row matches the headers and uses readable labels", () => {
  const r = validateWaitlist(good);
  assert.ok(r.ok);
  if (!r.ok) return;
  const row = toSheetRow(r.entry, new Date("2026-11-26T10:20:30Z"));
  assert.equal(row.length, SHEET_HEADERS.length);
  assert.equal(row[0], "2026-11-26 10:20:30");
  assert.equal(row[4], "Offramp — stablecoins to local currency");
  assert.equal(row[6], "Nigeria (NGN), Kenya (KES)");
  assert.equal(row[8], "$10k – $100k");
});

test("neutralises spreadsheet formulas in free text", () => {
  const r = validateWaitlist({ ...good, company: "=HYPERLINK(\"http://x\")", useCase: "+1 call me" });
  assert.ok(r.ok);
  if (!r.ok) return;
  const row = toSheetRow(r.entry, new Date());
  assert.ok(row[3].startsWith("'="));
  assert.ok(row[9].startsWith("'+"));
});
