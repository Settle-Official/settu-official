import test from "node:test";
import assert from "node:assert/strict";

import { BASELINE, summarise } from "./summarise.ts";

const inExport = new Set(["export-a", "export-b"]);
const done = (paycrestOrderId: string | undefined, destinationAmount?: string) =>
  ({ status: "completed" as const, paycrestOrderId, destinationAmount });

test("with no live records the figures are exactly the baseline", () => {
  assert.deepEqual(summarise([], 0, inExport), {
    transfers: BASELINE.transfers,
    settledNgn: BASELINE.settledNgn,
  });
});

test("an order already in the export is not counted a second time", () => {
  // The case a date cutoff got wrong: rebuilt history records carry the
  // rebuild time, so they look new while their orders are already counted.
  const s = summarise([done("export-a", "5000"), done("new-1", "7000")], 0, inExport);
  assert.equal(s.transfers, BASELINE.transfers + 1);
  assert.equal(s.settledNgn, BASELINE.settledNgn + 7000);
});

test("only completed offramps count", () => {
  const s = summarise(
    [
      { status: "pending", paycrestOrderId: "p", destinationAmount: "900" },
      { status: "failed", paycrestOrderId: "f", destinationAmount: "900" },
      done("c", "900"),
    ],
    0,
    inExport,
  );
  assert.equal(s.transfers, BASELINE.transfers + 1);
  assert.equal(s.settledNgn, BASELINE.settledNgn + 900);
});

test("a record with no order id is left out rather than risk a double count", () => {
  const s = summarise([done(undefined, "4000")], 0, inExport);
  assert.equal(s.transfers, BASELINE.transfers);
  assert.equal(s.settledNgn, BASELINE.settledNgn);
});

test("a completed offramp with no recorded payout counts, but adds no naira", () => {
  const s = summarise([done("x", undefined), done("y", "0"), done("z", "not a number")], 0, inExport);
  assert.equal(s.transfers, BASELINE.transfers + 3);
  assert.equal(s.settledNgn, BASELINE.settledNgn);
});

test("onramps add to transfers but never to naira paid out", () => {
  const s = summarise([], 4, inExport);
  assert.equal(s.transfers, BASELINE.transfers + 4);
  assert.equal(s.settledNgn, BASELINE.settledNgn);
});
