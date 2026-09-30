import test from "node:test";
import assert from "node:assert/strict";
import { findBurnForWaitingOrder, type WaitingBurnDeps } from "./waiting-burn";

const HASH = "2kyUCRTUoqo3NtgPPnsXaNN5rbYnRzVrouLHwfqVb1E7bkjt25fw724Lh1kd5PeFV8xp2vQwaSBfoguNzvBwP5tK";

function deps(overrides: Partial<WaitingBurnDeps> = {}) {
  const calls = { claim: 0, recover: 0, keptAlive: 0 };
  const d: WaitingBurnDeps = {
    getBurnForOrder: async () => null,
    claim: async () => {
      calls.claim++;
      return true;
    },
    recover: async () => {
      calls.recover++;
      return { outcome: "no-burn-found" };
    },
    keepAlive: () => {
      calls.keptAlive++;
    },
    timeoutMs: 200,
    ...overrides,
  };
  return { d, calls };
}

test("a burn already registered for the order is returned without a chain lookup", async () => {
  const { d, calls } = deps({ getBurnForOrder: async () => HASH });
  assert.equal(await findBurnForWaitingOrder("order-1", d), HASH);
  assert.equal(calls.claim, 0);
  assert.equal(calls.recover, 0);
});

test("inside the rate-limit window it answers null and skips the chain lookup", async () => {
  const { d, calls } = deps({ claim: async () => false });
  assert.equal(await findBurnForWaitingOrder("order-1", d), null);
  assert.equal(calls.recover, 0);
});

test("a recovery that finds the burn returns its hash", async () => {
  const { d } = deps({
    recover: async () => ({ outcome: "recovered", burnTxHash: HASH }),
  });
  assert.equal(await findBurnForWaitingOrder("order-1", d), HASH);
});

test("a burn registered by someone else in the meantime is still returned", async () => {
  const { d } = deps({
    recover: async () => ({ outcome: "already-registered", burnTxHash: HASH }),
  });
  assert.equal(await findBurnForWaitingOrder("order-1", d), HASH);
});

test("nothing on chain yet answers null", async () => {
  const { d } = deps();
  assert.equal(await findBurnForWaitingOrder("order-1", d), null);
});

test("a slow chain answers null in time and keeps the recovery running", async () => {
  let finished = false;
  const { d, calls } = deps({
    timeoutMs: 20,
    recover: () =>
      new Promise((resolve) =>
        setTimeout(() => {
          finished = true;
          resolve({ outcome: "recovered", burnTxHash: HASH });
        }, 80),
      ),
  });
  assert.equal(await findBurnForWaitingOrder("order-1", d), null);
  assert.equal(calls.keptAlive, 1);
  assert.equal(finished, false);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(finished, true);
});

test("a failing lookup answers null instead of erroring the poll", async () => {
  const { d } = deps({
    recover: async () => {
      throw new Error("rpc down");
    },
  });
  assert.equal(await findBurnForWaitingOrder("order-1", d), null);
});
