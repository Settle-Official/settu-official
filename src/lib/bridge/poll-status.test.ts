import test from "node:test";
import assert from "node:assert/strict";

import { pollBridgeStatus, POLL_INTERVAL_MS, POLL_MAX_MS, type PollDeps } from "./poll-status";
import type { BridgeStatusView } from "./bridge-store";

function view(status: BridgeStatusView["status"]): BridgeStatusView {
  return {
    id: "0xabc",
    status,
    source: "base",
    dest: "solana",
    sendAtomic: "1000000",
    receiveMinAtomic: "990000",
    sourceTx: "0xabc",
    canSelfClaim: false,
    fellBackToStandard: false,
  };
}

/** A fake clock + visibility: timers fire only when advanced. */
function harness(statuses: BridgeStatusView["status"][]) {
  let now = 0;
  let visible = true;
  let fetches = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  const listeners: (() => void)[] = [];
  let nextId = 1;
  const deps: PollDeps = {
    now: () => now,
    isVisible: () => visible,
    fetchStatus: async () => view(statuses[Math.min(fetches++, statuses.length - 1)]),
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    onVisibilityChange: (fn) => {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },
  };
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    deps,
    get fetches() {
      return fetches;
    },
    pending: () => timers.length,
    async advance(ms: number) {
      now += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > now) break;
        timers.shift();
        t.fn();
        await flush();
      }
    },
    async setVisible(v: boolean) {
      visible = v;
      listeners.slice().forEach((f) => f());
      await flush();
    },
    flush,
  };
}

test("polls every 5 s and stops at a final status", async () => {
  const h = harness(["verifying", "delivering", "completed"]);
  const seen: string[] = [];
  pollBridgeStatus("0xabc", (v) => seen.push(v.status), h.deps);
  await h.flush();
  assert.equal(h.fetches, 1);
  await h.advance(POLL_INTERVAL_MS);
  await h.advance(POLL_INTERVAL_MS);
  assert.deepEqual(seen, ["verifying", "delivering", "completed"]);
  await h.advance(POLL_INTERVAL_MS * 5);
  assert.equal(h.fetches, 3);
  assert.equal(h.pending(), 0);
});

test("makes no fetch while hidden, resumes when visible", async () => {
  const h = harness(["verifying"]);
  pollBridgeStatus("0xabc", () => {}, h.deps);
  await h.flush();
  assert.equal(h.fetches, 1);
  await h.setVisible(false);
  await h.advance(POLL_INTERVAL_MS * 4);
  assert.equal(h.fetches, 1);
  await h.setVisible(true);
  assert.equal(h.fetches, 2);
});

test("stops after 20 minutes and says so", async () => {
  const h = harness(["verifying"]);
  let timedOut = false;
  pollBridgeStatus("0xabc", () => {}, h.deps, () => {
    timedOut = true;
  });
  await h.flush();
  await h.advance(POLL_MAX_MS + POLL_INTERVAL_MS);
  const after = h.fetches;
  await h.advance(POLL_INTERVAL_MS * 3);
  assert.equal(h.fetches, after);
  assert.equal(timedOut, true);
});

test("stop() ends polling", async () => {
  const h = harness(["verifying"]);
  const stop = pollBridgeStatus("0xabc", () => {}, h.deps);
  await h.flush();
  stop();
  await h.advance(POLL_INTERVAL_MS * 3);
  assert.equal(h.fetches, 1);
});
