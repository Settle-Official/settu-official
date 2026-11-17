import test from "node:test";
import assert from "node:assert/strict";
import type { CctpStatus } from "../cctp/cctp-store";
import { handleDrive, type DriveDeps } from "./drive";

const ID = "0x" + "cd".repeat(32);

function deps(status: CctpStatus | Error, over: Partial<DriveDeps> = {}) {
  const scheduled: [string, number][] = [];
  const advanced: string[] = [];
  const d: DriveDeps = {
    signingKeys: () => ({ current: "cur", next: "nxt" }),
    verify: async (sig) => sig === "good",
    advance: async (id) => {
      advanced.push(id);
      if (status instanceof Error) throw status;
      return status;
    },
    schedule: async (id, a) => {
      scheduled.push([id, a]);
    },
    ...over,
  };
  return { d, scheduled, advanced };
}

const body = (attempt = 0, id = ID) => JSON.stringify({ id, attempt });

test("unsigned request -> 401, nothing advanced", async () => {
  const { d, advanced, scheduled } = deps("attesting");
  const r = await handleDrive({ pathId: ID, rawBody: body(), signature: null }, d);
  assert.equal(r.status, 401);
  assert.equal(advanced.length, 0);
  assert.equal(scheduled.length, 0);
});

test("bad signature -> 401", async () => {
  const { d, advanced } = deps("attesting");
  const r = await handleDrive({ pathId: ID, rawBody: body(), signature: "forged" }, d);
  assert.equal(r.status, 401);
  assert.equal(advanced.length, 0);
});

test("verifier throwing -> 401", async () => {
  const { d } = deps("attesting", { verify: async () => { throw new Error("SignatureError"); } });
  const r = await handleDrive({ pathId: ID, rawBody: body(), signature: "good" }, d);
  assert.equal(r.status, 401);
});

test("signing keys unset -> 401 even with a signature", async () => {
  let verified = false;
  const { d, advanced } = deps("attesting", {
    signingKeys: () => ({}),
    verify: async () => { verified = true; return true; },
  });
  const r = await handleDrive({ pathId: ID, rawBody: body(), signature: "good" }, d);
  assert.equal(r.status, 401);
  assert.equal(verified, false);
  assert.equal(advanced.length, 0);
});

test("only one signing key set -> 401", async () => {
  const { d } = deps("attesting", { signingKeys: () => ({ current: "cur" }) });
  const r = await handleDrive({ pathId: ID, rawBody: body(), signature: "good" }, d);
  assert.equal(r.status, 401);
});

test("final transfer is not rescheduled", async () => {
  for (const s of ["completed", "failed"] as const) {
    const { d, advanced, scheduled } = deps(s);
    const r = await handleDrive({ pathId: ID, rawBody: body(2), signature: "good" }, d);
    assert.equal(r.status, 200);
    assert.deepEqual(advanced, [ID]);
    assert.equal(scheduled.length, 0);
  }
});

test("non-final transfer is rescheduled at attempt + 1", async () => {
  const { d, scheduled } = deps("attesting");
  const r = await handleDrive({ pathId: ID, rawBody: body(2), signature: "good" }, d);
  assert.equal(r.status, 200);
  assert.deepEqual(scheduled, [[ID, 3]]);
});

test("advance error still reschedules (sweep is the backstop after the ladder)", async () => {
  const { d, scheduled } = deps(new Error("rpc down"));
  const r = await handleDrive({ pathId: ID, rawBody: body(0), signature: "good" }, d);
  assert.equal(r.status, 200);
  assert.deepEqual(scheduled, [[ID, 1]]);
});

test("schedule error does not fail the delivery", async () => {
  const { d } = deps("attesting", { schedule: async () => { throw new Error("qstash down"); } });
  const r = await handleDrive({ pathId: ID, rawBody: body(0), signature: "good" }, d);
  assert.equal(r.status, 200);
});

test("signed body for a different id -> 400, nothing advanced", async () => {
  const { d, advanced } = deps("attesting");
  const r = await handleDrive({ pathId: ID, rawBody: body(0, "0x" + "ee".repeat(32)), signature: "good" }, d);
  assert.equal(r.status, 400);
  assert.equal(advanced.length, 0);
});

test("malformed body / attempt -> 400", async () => {
  const { d } = deps("attesting");
  for (const raw of ["not json", JSON.stringify({ id: ID, attempt: -1 }), JSON.stringify({ id: ID, attempt: 1.5 }), JSON.stringify({ id: ID })]) {
    const r = await handleDrive({ pathId: ID, rawBody: raw, signature: "good" }, d);
    assert.equal(r.status, 400, raw);
  }
});
