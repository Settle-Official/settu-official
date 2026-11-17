import test from "node:test";
import assert from "node:assert/strict";
import { runSweepBurns } from "./sweep-burns";

const OFFRAMP = { scanned: 3, registered: 1 };

test("bridge sweep exception leaves the offramp result and status intact", async () => {
  const r = await runSweepBurns({
    offrampSweep: async () => OFFRAMP,
    bridgeSweep: async () => {
      throw new Error("bridge boom");
    },
    log: () => {},
  });
  assert.equal(r.status, 200);
  assert.deepEqual({ scanned: r.body.scanned, registered: r.body.registered }, OFFRAMP);
  assert.deepEqual(r.body.bridgeSweep, { error: "bridge boom" });
});

test("success: offramp result plus bridgeSweep key", async () => {
  const r = await runSweepBurns({
    offrampSweep: async () => OFFRAMP,
    bridgeSweep: async () => ({ created: 2, advanced: 5 }),
    log: () => {},
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ...OFFRAMP, bridgeSweep: { created: 2, advanced: 5 } });
});

test("bridge sweep runs only after the offramp sweep finishes", async () => {
  const order: string[] = [];
  await runSweepBurns({
    offrampSweep: async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("offramp");
      return OFFRAMP;
    },
    bridgeSweep: async () => {
      order.push("bridge");
      return { created: 0, advanced: 0 };
    },
    log: () => {},
  });
  assert.deepEqual(order, ["offramp", "bridge"]);
});

test("offramp failure keeps its 500 + error message; bridge sweep still runs", async () => {
  let ran = false;
  const r = await runSweepBurns({
    offrampSweep: async () => {
      throw new Error("offramp boom");
    },
    bridgeSweep: async () => {
      ran = true;
      return { created: 0, advanced: 0 };
    },
    log: () => {},
  });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "offramp boom");
  assert.equal(ran, true);
});

test("offramp failure without a message keeps the old default", async () => {
  const r = await runSweepBurns({
    offrampSweep: async () => {
      throw {};
    },
    bridgeSweep: async () => ({ created: 0, advanced: 0 }),
    log: () => {},
  });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "burn sweep failed");
});

test("a hanging bridge sweep times out; offramp result returned with its status", async () => {
  const r = await runSweepBurns({
    offrampSweep: async () => OFFRAMP,
    bridgeSweep: () => new Promise(() => {}),
    log: () => {},
    budgetMs: 2_050,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.scanned, 3);
  assert.deepEqual(r.body.bridgeSweep, { error: "timed out" });
});

test("no time left after the offramp sweep: bridge sweep skipped", async () => {
  let ran = false;
  let t = 0;
  const r = await runSweepBurns({
    offrampSweep: async () => {
      t = 49_000;
      return OFFRAMP;
    },
    bridgeSweep: async () => {
      ran = true;
      return { created: 0, advanced: 0 };
    },
    log: () => {},
    now: () => t,
  });
  assert.equal(ran, false);
  assert.equal(r.status, 200);
  assert.match(String((r.body.bridgeSweep as { error: string }).error), /skipped/);
});
