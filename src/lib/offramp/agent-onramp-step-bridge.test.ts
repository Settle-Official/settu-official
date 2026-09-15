import test from "node:test";
import assert from "node:assert/strict";
import { onrampStatusToAgentEvent } from "./agent-onramp-step-bridge";

test("pending maps to a progress event with the standard copy", () => {
  const event = onrampStatusToAgentEvent("pending", {});
  assert.ok(event);
  assert.equal(event!.kind, "progress");
  assert.equal(event!.text, "Waiting for your bank transfer…");
});

test("delivered maps to a success event and includes a shortened tx hash", () => {
  const event = onrampStatusToAgentEvent("delivered", {
    stellarTxHash: "abcdef1234567890abcdef1234567890",
  });
  assert.ok(event);
  assert.equal(event!.kind, "success");
  assert.match(event!.text, /abcdef12/);
});

test("delivered with no tx hash still returns a success event", () => {
  const event = onrampStatusToAgentEvent("delivered", {});
  assert.ok(event);
  assert.equal(event!.kind, "success");
});

test("bridge_failed maps to an error event", () => {
  const event = onrampStatusToAgentEvent("bridge_failed", {});
  assert.ok(event);
  assert.equal(event!.kind, "error");
});

test("refunded and expired map to error events with their own copy", () => {
  const refunded = onrampStatusToAgentEvent("refunded", {});
  const expired = onrampStatusToAgentEvent("expired", {});
  assert.ok(refunded);
  assert.ok(expired);
  assert.equal(refunded!.kind, "error");
  assert.equal(expired!.kind, "error");
  assert.notEqual(refunded!.text, expired!.text);
});

test("an unrecognized status returns null rather than a made-up message", () => {
  assert.equal(onrampStatusToAgentEvent("some-future-status", {}), null);
});
