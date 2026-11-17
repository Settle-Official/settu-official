import test from "node:test";
import assert from "node:assert/strict";

import { estimatedTime } from "./eta";

test("Standard from an Ethereum-secured chain waits for Ethereum finality", () => {
  for (const c of ["ethereum", "base", "arbitrum", "optimism"] as const) {
    assert.equal(estimatedTime(c, "standard"), "~15–20 min");
  }
});

test("Fast from those chains is under a minute", () => {
  assert.equal(estimatedTime("base", "fast"), "under a minute");
  assert.equal(estimatedTime("ethereum", "fast"), "~1 min");
});

test("chains that are already fast on Standard say so on both speeds", () => {
  for (const c of ["stellar", "solana", "avalanche", "polygon"] as const) {
    assert.equal(estimatedTime(c, "standard"), "under a minute");
    assert.equal(estimatedTime(c, "fast"), "under a minute");
  }
});
