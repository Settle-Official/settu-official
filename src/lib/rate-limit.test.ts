import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimit, clientIp } from "./rate-limit";

test("allows calls under the limit", () => {
  const limiter = createRateLimit(3, 60_000);
  for (let i = 0; i < 3; i++) assert.equal(limiter.check("a"), true);
});

test("blocks once the limit is exceeded within the window", () => {
  const limiter = createRateLimit(3, 60_000);
  for (let i = 0; i < 3; i++) limiter.check("b");
  assert.equal(limiter.check("b"), false);
});

test("different keys are independent", () => {
  const limiter = createRateLimit(2, 60_000);
  for (let i = 0; i < 2; i++) limiter.check("c");
  assert.equal(limiter.check("c"), false);
  assert.equal(limiter.check("d"), true);
});

test("a blocked key recovers once its window passes", async () => {
  const limiter = createRateLimit(1, 20);
  assert.equal(limiter.check("e"), true);
  assert.equal(limiter.check("e"), false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(limiter.check("e"), true);
});

test("reset clears every bucket", () => {
  const limiter = createRateLimit(1, 60_000);
  limiter.check("f");
  assert.equal(limiter.check("f"), false);
  limiter.reset();
  assert.equal(limiter.check("f"), true);
});

test("clientIp takes the first forwarded hop", () => {
  const headers = new Headers({ "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" });
  assert.equal(clientIp(headers), "1.2.3.4");
});

test("clientIp falls back to a shared bucket without the header", () => {
  assert.equal(clientIp(new Headers()), "unknown");
});
