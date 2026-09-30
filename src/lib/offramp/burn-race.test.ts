import test from "node:test";
import assert from "node:assert/strict";
import { raceBurnAgainstRecovery } from "./burn-race";

const HASH = "0xburn";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A document stand-in: tests fire "visibilitychange" by hand.
function fakeDocument(visible = true) {
  const listeners = new Set<() => void>();
  return {
    visibilityState: visible ? "visible" : "hidden",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    fire() {
      listeners.forEach((fn) => fn());
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

test("the wallet's own reply wins when it arrives first", async () => {
  const doc = fakeDocument();
  let checks = 0;
  const result = await raceBurnAgainstRecovery({
    wallet: Promise.resolve(HASH),
    check: async () => {
      checks++;
      return null;
    },
    doc,
    firstCheckAfterMs: 1_000,
    intervalMs: 1_000,
  });
  assert.deepEqual(result, { burnTxHash: HASH, via: "wallet" });
  assert.equal(checks, 0);
  assert.equal(doc.listenerCount, 0);
});

test("coming back to the page finds a burn whose wallet reply was lost", async () => {
  const doc = fakeDocument();
  const pending = raceBurnAgainstRecovery({
    wallet: new Promise<string>(() => {}), // the reply never arrives
    check: async () => HASH,
    doc,
    firstCheckAfterMs: 60_000,
    intervalMs: 60_000,
  });
  doc.fire();
  assert.deepEqual(await pending, { burnTxHash: HASH, via: "server" });
  assert.equal(doc.listenerCount, 0);
});

test("the periodic check finds it even if the page never loses focus", async () => {
  let checks = 0;
  const result = await raceBurnAgainstRecovery({
    wallet: new Promise<string>(() => {}),
    check: async () => (++checks >= 2 ? HASH : null),
    doc: fakeDocument(),
    firstCheckAfterMs: 5,
    intervalMs: 5,
  });
  assert.deepEqual(result, { burnTxHash: HASH, via: "server" });
  assert.equal(checks, 2);
});

test("a wallet rejection still fails the flow", async () => {
  await assert.rejects(
    raceBurnAgainstRecovery({
      wallet: Promise.reject(new Error("User rejected the request")),
      check: async () => null,
      doc: fakeDocument(),
      firstCheckAfterMs: 1_000,
      intervalMs: 1_000,
    }),
    /User rejected/,
  );
});

test("a late wallet failure after the server won is swallowed", async () => {
  let rejectWallet!: (e: Error) => void;
  const wallet = new Promise<string>((_, reject) => {
    rejectWallet = reject;
  });
  const doc = fakeDocument();
  const pending = raceBurnAgainstRecovery({
    wallet,
    check: async () => HASH,
    doc,
    firstCheckAfterMs: 60_000,
    intervalMs: 60_000,
  });
  doc.fire();
  assert.equal((await pending).via, "server");
  // Would surface as an unhandled rejection and fail the test run.
  rejectWallet(new Error("relay closed"));
  await wait(10);
});

test("a failing check is retried rather than failing the flow", async () => {
  let checks = 0;
  const result = await raceBurnAgainstRecovery({
    wallet: new Promise<string>(() => {}),
    check: async () => {
      checks++;
      if (checks === 1) throw new Error("network");
      return HASH;
    },
    doc: fakeDocument(),
    firstCheckAfterMs: 5,
    intervalMs: 5,
  });
  assert.equal(result.via, "server");
});

test("a hidden page skips the periodic check until it is visible again", async () => {
  const doc = fakeDocument(false);
  let checks = 0;
  const pending = raceBurnAgainstRecovery({
    wallet: new Promise<string>(() => {}),
    check: async () => {
      checks++;
      return HASH;
    },
    doc,
    firstCheckAfterMs: 5,
    intervalMs: 5,
  });
  await wait(30);
  assert.equal(checks, 0);
  doc.visibilityState = "visible";
  doc.fire();
  assert.equal((await pending).via, "server");
});

test("a wallet timeout with the burn already on chain still succeeds", async () => {
  const result = await raceBurnAgainstRecovery({
    wallet: Promise.reject(new Error("We didn't hear back from your wallet.")),
    check: async () => HASH,
    doc: fakeDocument(),
    firstCheckAfterMs: 60_000,
    intervalMs: 60_000,
  });
  assert.deepEqual(result, { burnTxHash: HASH, via: "server" });
});

test("a wallet timeout with nothing on chain still fails the flow", async () => {
  await assert.rejects(
    raceBurnAgainstRecovery({
      wallet: Promise.reject(new Error("We didn't hear back from your wallet.")),
      check: async () => null,
      doc: fakeDocument(),
      firstCheckAfterMs: 60_000,
      intervalMs: 60_000,
    }),
    /didn't hear back/,
  );
});

test("a user rejection fails at once, without asking the server", async () => {
  let checks = 0;
  await assert.rejects(
    raceBurnAgainstRecovery({
      wallet: Promise.reject(new Error("User rejected the request")),
      check: async () => {
        checks++;
        return HASH;
      },
      doc: fakeDocument(),
      firstCheckAfterMs: 60_000,
      intervalMs: 60_000,
    }),
  );
  assert.equal(checks, 0);
});

test("a cancelled flow stops checking and never settles", async () => {
  let cancelled = false;
  let checks = 0;
  const doc = fakeDocument();
  let settled = false;
  void raceBurnAgainstRecovery({
    wallet: new Promise<string>(() => {}),
    check: async () => {
      checks++;
      return null;
    },
    doc,
    firstCheckAfterMs: 5,
    intervalMs: 5,
    abandoned: () => cancelled,
  }).finally(() => {
    settled = true;
  });
  await wait(12);
  cancelled = true;
  const before = checks;
  await wait(30);
  assert.ok(checks <= before + 1);
  assert.equal(doc.listenerCount, 0);
  assert.equal(settled, false);
});
