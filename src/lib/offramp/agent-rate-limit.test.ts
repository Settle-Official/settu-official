import test from "node:test";
import assert from "node:assert/strict";
import { checkAgentRateLimit, _resetForTests } from "./agent-rate-limit";

test("allows calls under the limit", () => {
  _resetForTests();
  for (let i = 0; i < 10; i++) {
    assert.equal(checkAgentRateLimit("wallet-a"), true);
  }
});

test("blocks the call once the limit is exceeded within the window", () => {
  _resetForTests();
  for (let i = 0; i < 10; i++) checkAgentRateLimit("wallet-b");
  assert.equal(checkAgentRateLimit("wallet-b"), false);
});

test("different keys are independent", () => {
  _resetForTests();
  for (let i = 0; i < 10; i++) checkAgentRateLimit("wallet-c");
  assert.equal(checkAgentRateLimit("wallet-c"), false);
  assert.equal(checkAgentRateLimit("wallet-d"), true);
});
