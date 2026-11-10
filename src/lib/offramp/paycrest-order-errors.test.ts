import test from "node:test";
import assert from "node:assert/strict";

import { friendlyOrderError, marketRateFromToleranceError } from "./paycrest-order-errors";

// The exact body a user hit on 2026-11-10.
const TOLERANCE_BODY = {
  status: "error",
  message: "Failed to validate payload",
  data: {
    field: "Rate",
    message: "Provided rate 1374.12 is outside 0.20% tolerance of market rate 1370.12",
  },
};

test("reads the market rate out of a PaycrestHttpError-shaped tolerance rejection", () => {
  const err = Object.assign(new Error("Failed to validate payload"), { status: 400, details: TOLERANCE_BODY });
  assert.equal(marketRateFromToleranceError(err), 1370.12);
});

test("reads it from the route's JSON error payload too", () => {
  assert.equal(
    marketRateFromToleranceError({ error: "Failed to validate payload", message: "Failed to validate payload", details: TOLERANCE_BODY }),
    1370.12,
  );
});

test("ignores other validation errors", () => {
  const err = Object.assign(new Error("Failed to validate payload"), {
    details: { data: { field: "AccountIdentifier", message: "invalid account" } },
  });
  assert.equal(marketRateFromToleranceError(err), null);
  assert.equal(marketRateFromToleranceError(null), null);
});

test("the user never sees the raw payload", () => {
  const msg = friendlyOrderError({ message: "Failed to validate payload", details: TOLERANCE_BODY }, 400);
  assert.match(msg, /exchange rate changed/);
  assert.doesNotMatch(msg, /details|tolerance|\{/);
});

test("maps rate-moved, timeouts, bank and fallback errors to plain messages", () => {
  assert.match(friendlyOrderError({ code: "RATE_MOVED" }, 409), /exchange rate changed/);
  assert.match(friendlyOrderError({}, 504), /taking too long/);
  assert.match(
    friendlyOrderError({ details: { data: { field: "AccountIdentifier" } } }, 400),
    /bank details/,
  );
  assert.match(friendlyOrderError({ message: "boom" }, 500), /couldn't set up your payout/);
  for (const status of [400, 409, 500, 504]) {
    assert.match(friendlyOrderError({}, status), /No funds have left your wallet\./);
  }
});
