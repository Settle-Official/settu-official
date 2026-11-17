import test from "node:test";
import assert from "node:assert/strict";
import { DRIVE_DELAYS_S, driveUrl, scheduleDrive, type ScheduleDeps } from "./schedule";

function deps(over: Partial<ScheduleDeps> = {}) {
  const published: { url: string; body: unknown; delay: number; deduplicationId: string }[] = [];
  const logs: string[] = [];
  const d: ScheduleDeps = {
    token: () => "tok",
    baseUrl: () => "https://settu.example/",
    publish: async (r) => {
      published.push(r);
    },
    log: (m) => logs.push(m),
    ...over,
  };
  return { d, published, logs };
}

test("delays for attempts 0-4 are 15, 30, 60, 120, 300 seconds", async () => {
  assert.deepEqual([...DRIVE_DELAYS_S], [15, 30, 60, 120, 300]);
  const { d, published } = deps();
  for (let a = 0; a < 5; a++) await scheduleDrive("0xabc", a, d);
  assert.deepEqual(published.map((p) => p.delay), [15, 30, 60, 120, 300]);
  assert.equal(published[0].url, "https://settu.example/api/bridge/drive/0xabc");
  assert.deepEqual(published[2].body, { id: "0xabc", attempt: 2 });
  assert.equal(published[3].deduplicationId, "bridge-drive-0xabc-3");
});

test("attempt 5 (past the ladder) publishes nothing", async () => {
  const { d, published } = deps();
  await scheduleDrive("0xabc", 5, d);
  await scheduleDrive("0xabc", 6, d);
  assert.equal(published.length, 0);
});

test("default attempt is 0", async () => {
  const { d, published } = deps();
  await scheduleDrive("0xabc", undefined, d);
  assert.equal(published[0].delay, 15);
});

test("QSTASH_TOKEN unset: logs once, no-op, no throw", async () => {
  const { d, published, logs } = deps({ token: () => undefined });
  await scheduleDrive("0xabc", 0, d);
  await scheduleDrive("0xdef", 1, d);
  assert.equal(published.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /QSTASH_TOKEN/);
});

test("APP_BASE_URL unset: no-op, no throw", async () => {
  const { d, published } = deps({ baseUrl: () => undefined });
  await scheduleDrive("0xabc", 0, d);
  assert.equal(published.length, 0);
});

test("driveUrl strips trailing slashes and encodes the id", () => {
  assert.equal(driveUrl("https://a.b//", "x y"), "https://a.b/api/bridge/drive/x%20y");
});
