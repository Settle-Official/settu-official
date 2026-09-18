import test from "node:test";
import assert from "node:assert/strict";
import {
  canCover,
  creationReserveCost,
  minimumBalance,
  remainingCapacity,
  spendableXlm,
  trustlineReserveCost,
} from "./reserves";

const fresh = (balanceXlm: number) => ({
  balanceXlm,
  subentryCount: 0,
  numSponsoring: 0,
  numSponsored: 0,
});

test("a fresh account's minimum is two base reserves", () => {
  assert.equal(minimumBalance(fresh(5)), 1);
});

test("sponsored entries raise the sponsor's own minimum", () => {
  // The reserves live with the sponsor, so its floor grows per wallet.
  const afterTwoWallets = {
    balanceXlm: 5,
    subentryCount: 0,
    numSponsoring: 6,
    numSponsored: 0,
  };
  assert.equal(minimumBalance(afterTwoWallets), 4);
});

test("entries sponsored for an account don't count against it", () => {
  const sponsoredUser = {
    balanceXlm: 0,
    subentryCount: 1,
    numSponsoring: 0,
    numSponsored: 3,
  };
  // A Settu wallet holds nothing itself, which is the point of sponsorship.
  assert.ok(minimumBalance(sponsoredUser) <= 0);
});

test("a wallet with one trustline costs 1.5 XLM", () => {
  assert.equal(creationReserveCost(1), 1.5);
  assert.equal(trustlineReserveCost(), 0.5);
});

test("the real case: 5 XLM funds two wallets and refuses the third", () => {
  let state = fresh(5);
  const cost = creationReserveCost(1);

  assert.equal(canCover(state, cost), true);
  state = { ...state, balanceXlm: 5, numSponsoring: 3 };
  assert.equal(canCover(state, cost), true);

  // Third would drop the sponsor under its own minimum.
  state = { ...state, numSponsoring: 6 };
  assert.equal(canCover(state, cost), false);
});

test("capacity is reported, not guessed", () => {
  assert.equal(remainingCapacity(fresh(5)), 2);
  assert.equal(remainingCapacity(fresh(3)), 1);
  assert.equal(remainingCapacity(fresh(200)), 131);
});

test("an account at exactly its minimum can cover nothing", () => {
  const state = { ...fresh(1), numSponsoring: 0 };
  assert.equal(spendableXlm(state), 0);
  assert.equal(canCover(state, creationReserveCost(1)), false);
  assert.equal(remainingCapacity(state), 0);
});

test("an extra buffer only ever makes it stricter", () => {
  const state = fresh(5);
  const cost = creationReserveCost(1);
  assert.equal(canCover(state, cost), true);
  assert.equal(canCover(state, cost, 10), false);
});

test("fees are accounted for, so a balance that exactly matches is refused", () => {
  // 1 XLM minimum + 1.5 cost = 2.5, which leaves nothing for the fee.
  assert.equal(canCover(fresh(2.5), creationReserveCost(1)), false);
  assert.equal(canCover(fresh(2.51), creationReserveCost(1)), true);
});

test("boundaries hold exactly, with no floating-point drift", () => {
  // 2.51 - 1 is 1.5099999999999998 in floating point; in stroops it is exact.
  assert.equal(canCover(fresh(2.5099999), creationReserveCost(1)), false);
  for (const xlm of [2.51, 4.01, 5.51, 10.51]) {
    assert.equal(canCover(fresh(xlm), creationReserveCost(1)), true, `${xlm}`);
  }
});
