import test from "node:test";
import assert from "node:assert/strict";

import {
  runBridgeFlow,
  progressCopy,
  resultActions,
  RegisterRetryableError,
  type BridgeFlowDeps,
  type FlowStep,
} from "./bridge-flow";
import type { QuoteSuccess } from "./build-quote";
import type { SourceTx } from "./build-source-tx";
import type { BridgeStatusView } from "./bridge-store";

const NOW = 1_800_000_000;

function quote(expiresAt: number, receive = "990000"): QuoteSuccess {
  return {
    quote: { amount: "1000000" } as QuoteSuccess["quote"],
    signature: "0x",
    breakdown: { receiveAtomic: receive } as QuoteSuccess["breakdown"],
    expiresAt,
    contract: "0x341EBE07baDC61621D8Fa4298abcd43c7B4F5FB0",
  };
}

const VIEW: BridgeStatusView = {
  id: "0xhash",
  status: "verifying",
  source: "base",
  dest: "solana",
  sendAtomic: "1000000",
  receiveMinAtomic: "990000",
  sourceTx: "0xhash",
  canSelfClaim: false,
  fellBackToStandard: false,
};

function deps(over: Partial<BridgeFlowDeps> = {}): BridgeFlowDeps & { calls: string[] } {
  const calls: string[] = [];
  const d: BridgeFlowDeps = {
    now: () => NOW,
    refreshQuote: async () => {
      calls.push("refreshQuote");
      return quote(NOW + 120, "980000");
    },
    buildTx: async () => {
      calls.push("buildTx");
      return { family: "solana", txBase64: "AA==" } as SourceTx;
    },
    approve: async () => {
      calls.push("approve");
    },
    signAndSend: async () => {
      calls.push("signAndSend");
      return "0xhash";
    },
    register: async () => {
      calls.push("register");
      return VIEW;
    },
    sleep: async () => {},
    onStep: () => {},
    ...over,
  };
  return Object.assign(d, { calls });
}

test("review focus 1: an expiring quote is refreshed and returned for reconfirmation, wallet untouched", async () => {
  const d = deps();
  const r = await runBridgeFlow({ quote: quote(NOW + 10), source: "solana", user: "u" }, d);
  assert.equal(r.kind, "needsReconfirm");
  assert.equal(r.kind === "needsReconfirm" && r.quote.breakdown.receiveAtomic, "980000");
  assert.deepEqual(d.calls, ["refreshQuote"]);
});

test("a fresh quote goes build → sign → register and reports each step", async () => {
  const steps: FlowStep[] = [];
  const d = deps({ onStep: (s) => steps.push(s) });
  const r = await runBridgeFlow({ quote: quote(NOW + 120), source: "solana", user: "u" }, d);
  assert.equal(r.kind, "registered");
  assert.equal(r.kind === "registered" && r.txHash, "0xhash");
  assert.deepEqual(d.calls, ["buildTx", "signAndSend", "register"]);
  assert.deepEqual(steps, ["confirm", "sending"]);
});

test("EVM needing approval approves, then rebuilds before signing", async () => {
  let built = 0;
  const steps: FlowStep[] = [];
  const d = deps({
    onStep: (s) => steps.push(s),
    buildTx: async () => {
      built++;
      d.calls.push("buildTx");
      return { family: "evm", chainId: 84532, to: "0x1", data: "0x", value: "0", needsApproval: built === 1 } as SourceTx;
    },
  });
  await runBridgeFlow({ quote: quote(NOW + 120), source: "base", user: "u" }, d);
  assert.deepEqual(d.calls, ["buildTx", "approve", "buildTx", "signAndSend", "register"]);
  assert.deepEqual(steps, ["approve", "confirm", "sending"]);
});

test("registration retries while the tx isn't indexed, then succeeds", async () => {
  let tries = 0;
  const d = deps({
    register: async () => {
      tries++;
      if (tries < 3) throw new RegisterRetryableError("not yet");
      return VIEW;
    },
  });
  const r = await runBridgeFlow({ quote: quote(NOW + 120), source: "solana", user: "u" }, d);
  assert.equal(r.kind, "registered");
  assert.equal(tries, 3);
});

test("registration that never lands still returns the tx hash (the sweep picks it up)", async () => {
  const d = deps({
    register: async () => {
      throw new RegisterRetryableError("not yet");
    },
  });
  const r = await runBridgeFlow({ quote: quote(NOW + 120), source: "solana", user: "u" }, d);
  assert.equal(r.kind, "sentUnregistered");
  assert.equal(r.kind === "sentUnregistered" && r.txHash, "0xhash");
});

test("a fellBackToStandard view says it's taking the standard route", () => {
  assert.equal(
    progressCopy({ ...VIEW, status: "verifying", fellBackToStandard: true }),
    "Taking the standard route — still on its way",
  );
});

test("canSelfClaim offers 'Claim it yourself'", () => {
  assert.ok(resultActions({ ...VIEW, status: "delivering", canSelfClaim: true }).includes("Claim it yourself"));
  assert.ok(!resultActions(VIEW).includes("Claim it yourself"));
});

test("final review: a quote that runs out during the USDC approval is refreshed for reconfirmation, not sent", async () => {
  let clock = NOW;
  let built = 0;
  const d = deps({
    now: () => clock,
    buildTx: async () => {
      built++;
      d.calls.push("buildTx");
      return { family: "evm", chainId: 84532, to: "0x1", data: "0x", value: "0", needsApproval: built === 1 } as SourceTx;
    },
    approve: async () => {
      d.calls.push("approve");
      clock += 110; // the wallet confirmation and the approval's confirmation took 110 s
    },
  });
  const r = await runBridgeFlow({ quote: quote(NOW + 120), source: "base", user: "u" }, d);
  assert.equal(r.kind, "needsReconfirm");
  assert.deepEqual(d.calls, ["buildTx", "approve", "refreshQuote"]);
});
