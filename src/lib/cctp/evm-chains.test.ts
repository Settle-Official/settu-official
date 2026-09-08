import test from "node:test";
import assert from "node:assert/strict";
import { EVM_SOURCE_CHAINS, isCctpBridgeChain } from "./evm-chains";

test("every EVM source chain has a valid 0x USDC address", () => {
  for (const [key, config] of Object.entries(EVM_SOURCE_CHAINS)) {
    assert.match(config.usdcAddress, /^0x[a-fA-F0-9]{40}$/, `${key} usdcAddress`);
  }
});

test("base is the only direct-kind chain; the rest are cctp-bridge", () => {
  assert.equal(EVM_SOURCE_CHAINS.base.kind, "direct");
  for (const key of ["ethereum", "arbitrum", "optimism", "avalanche", "polygon"] as const) {
    assert.equal(EVM_SOURCE_CHAINS[key].kind, "cctp-bridge");
  }
});

test("cctp-bridge chains have distinct, correct CCTP domain IDs", () => {
  assert.equal(EVM_SOURCE_CHAINS.ethereum.kind === "cctp-bridge" && EVM_SOURCE_CHAINS.ethereum.cctpDomain, 0);
  assert.equal(EVM_SOURCE_CHAINS.avalanche.kind === "cctp-bridge" && EVM_SOURCE_CHAINS.avalanche.cctpDomain, 1);
  assert.equal(EVM_SOURCE_CHAINS.optimism.kind === "cctp-bridge" && EVM_SOURCE_CHAINS.optimism.cctpDomain, 2);
  assert.equal(EVM_SOURCE_CHAINS.arbitrum.kind === "cctp-bridge" && EVM_SOURCE_CHAINS.arbitrum.cctpDomain, 3);
  assert.equal(EVM_SOURCE_CHAINS.polygon.kind === "cctp-bridge" && EVM_SOURCE_CHAINS.polygon.cctpDomain, 7);
});

test("isCctpBridgeChain narrows correctly", () => {
  assert.equal(isCctpBridgeChain(EVM_SOURCE_CHAINS.base), false);
  assert.equal(isCctpBridgeChain(EVM_SOURCE_CHAINS.ethereum), true);
});
