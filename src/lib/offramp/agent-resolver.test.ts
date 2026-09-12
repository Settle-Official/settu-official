import test from "node:test";
import assert from "node:assert/strict";

// sourceChainOptions() (used inside agent-resolver) reads this env var at
// call time to decide which EVM chains are enabled. Bare `node --test`
// doesn't load .env.local the way `next dev`/`next build` do, so this test
// file — run in its own process by Node's test runner — sets it explicitly
// rather than depending on the ambient dev environment.
process.env.NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED = "base";

import {
  classifyExtraction,
  resolveAgentOrder,
  type AgentOrderExtraction,
} from "./agent-resolver";

const COMPLETE: AgentOrderExtraction = {
  amount: "1000",
  token: "USDC",
  sourceChain: "base",
  destinationCurrency: "NGN",
  institutionName: "OPay",
  accountIdentifier: "0987654321",
};

test("classifyExtraction: fully populated is complete", () => {
  assert.equal(classifyExtraction(COMPLETE).status, "complete");
});

test("classifyExtraction: one missing field asks a targeted question, not a recap", () => {
  const result = classifyExtraction({ ...COMPLETE, accountIdentifier: null });
  assert.equal(result.status, "clarify");
  if (result.status === "clarify") {
    assert.match(result.message, /account number/i);
  }
});

test("classifyExtraction: two missing fields still asks (not a recap)", () => {
  const result = classifyExtraction({ ...COMPLETE, accountIdentifier: null, amount: null });
  assert.equal(result.status, "clarify");
});

test("classifyExtraction: three or more missing fields is a recap, not a question", () => {
  const result = classifyExtraction({
    ...COMPLETE,
    accountIdentifier: null,
    amount: null,
    sourceChain: null,
  });
  assert.equal(result.status, "recap");
  if (result.status === "recap") {
    assert.equal(result.missing.length, 3);
  }
});

function withFetch(impl: typeof globalThis.fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

test("resolveAgentOrder: happy path resolves with the verified name and real institution code", async () => {
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("/currencies")) {
      return jsonResponse({ data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }] });
    }
    if (u.includes("/institutions/")) {
      return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }, { code: "GTBNGPC", name: "GTBank" }] });
    }
    if (u.includes("/verify-account")) {
      return jsonResponse({ data: { accountName: "JOHN DOE" } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }, async () => {
    const result = await resolveAgentOrder(COMPLETE);
    assert.equal(result.status, "resolved");
    if (result.status === "resolved") {
      assert.equal(result.order.beneficiary.institution, "OPAYNGPC");
      assert.equal(result.order.beneficiary.accountName, "JOHN DOE");
      assert.equal(result.order.beneficiary.currency, "NGN");
      assert.equal(result.order.sourceChain, "base");
    }
  });
});

test("resolveAgentOrder: unresolvable bank name asks which bank, not a guess", async () => {
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("/currencies")) return jsonResponse({ data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }] });
    if (u.includes("/institutions/")) return jsonResponse({ data: [{ code: "GTBNGPC", name: "GTBank" }] });
    throw new Error(`unexpected fetch: ${u}`);
  }, async () => {
    const result = await resolveAgentOrder({ ...COMPLETE, institutionName: "SomeBankThatDoesNotExist" });
    assert.equal(result.status, "clarify");
    if (result.status === "clarify") assert.match(result.message, /bank/i);
  });
});

test("resolveAgentOrder: failed account verification asks to double check the number", async () => {
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("/currencies")) return jsonResponse({ data: [{ code: "NGN", name: "Nigerian Naira", symbol: "₦" }] });
    if (u.includes("/institutions/")) return jsonResponse({ data: [{ code: "OPAYNGPC", name: "OPay" }] });
    if (u.includes("/verify-account")) return jsonResponse({}, false);
    throw new Error(`unexpected fetch: ${u}`);
  }, async () => {
    const result = await resolveAgentOrder(COMPLETE);
    assert.equal(result.status, "clarify");
    if (result.status === "clarify") assert.match(result.message, /account number/i);
  });
});

test("resolveAgentOrder: unsupported currency asks for a different one", async () => {
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("/currencies")) return jsonResponse({ data: [{ code: "KES", name: "Kenyan Shilling", symbol: "KSh" }] });
    throw new Error(`unexpected fetch: ${u}`);
  }, async () => {
    const result = await resolveAgentOrder(COMPLETE);
    assert.equal(result.status, "clarify");
    if (result.status === "clarify") assert.match(result.message, /NGN|currency|support/i);
  });
});
