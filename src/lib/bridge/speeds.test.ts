import test from "node:test";
import assert from "node:assert/strict";

import { offersFast } from "./speeds";

test("Fast is offered only where Circle runs Fast Transfer", () => {
  for (const c of ["ethereum", "base", "arbitrum", "optimism", "solana"] as const) {
    assert.equal(offersFast(c), true, c);
  }
});

test("Stellar, Avalanche and Polygon are Standard-only (already fast there)", () => {
  for (const c of ["stellar", "avalanche", "polygon"] as const) {
    assert.equal(offersFast(c), false, c);
  }
});
