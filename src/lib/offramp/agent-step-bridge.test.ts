import test from "node:test";
import assert from "node:assert/strict";
import { stepToAgentEvent } from "./agent-step-bridge";

test("idle produces no message", () => {
  assert.equal(stepToAgentEvent("idle", { sourceChainLabel: "Base" }), null);
});

test("awaiting-signature asks the user to check their wallet", () => {
  const event = stepToAgentEvent("awaiting-signature", { sourceChainLabel: "Base" });
  assert.equal(event?.kind, "progress");
  assert.match(event!.text, /wallet/i);
});

test("submitting names the source chain", () => {
  const event = stepToAgentEvent("submitting", { sourceChainLabel: "Solana" });
  assert.match(event!.text, /Solana/);
});

test("error uses the supplied error text verbatim, not a generic message", () => {
  const event = stepToAgentEvent("error", {
    sourceChainLabel: "Base",
    error: "Insufficient USDC balance. You have 2.00 USDC but are trying to send 5 USDC.",
  });
  assert.equal(event?.kind, "error");
  assert.match(event!.text, /Insufficient USDC balance/);
});

test("error with no supplied text still returns a usable message", () => {
  const event = stepToAgentEvent("error", { sourceChainLabel: "Base", error: null });
  assert.equal(event?.kind, "error");
  assert.ok(event!.text.length > 0);
});

test("success is a distinct kind", () => {
  const event = stepToAgentEvent("success", { sourceChainLabel: "Base" });
  assert.equal(event?.kind, "success");
});

test("every non-idle step has a unique, stable id per step value", () => {
  const steps = ["initiating", "awaiting-signature", "submitting", "processing", "settling", "success", "error"] as const;
  const ids = steps.map((s) => stepToAgentEvent(s, { sourceChainLabel: "Base" })!.id);
  assert.equal(new Set(ids).size, ids.length);
});
