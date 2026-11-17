import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE_CHAINS,
  BRIDGE_CHAIN_OPTIONS,
  bridgeChainByDomain,
  type BridgeChainKey,
} from "./chains";
import { CCTP_DOMAIN } from "../cctp/constants";

const DOMAINS: Record<BridgeChainKey, number> = {
  ethereum: 0,
  avalanche: 1,
  optimism: 2,
  arbitrum: 3,
  solana: 5,
  base: 6,
  polygon: 7,
  stellar: 27,
};

test("domains match Circle", () => {
  for (const [key, domain] of Object.entries(DOMAINS)) {
    assert.equal(BRIDGE_CHAINS[key as BridgeChainKey].cctpDomain, domain, key);
    assert.equal(CCTP_DOMAIN[key as BridgeChainKey], domain, key);
  }
});

test("decimals: stellar 7, all others 6", () => {
  for (const c of Object.values(BRIDGE_CHAINS)) {
    assert.equal(c.usdcDecimals, c.key === "stellar" ? 7 : 6, c.key);
  }
});

test("family", () => {
  for (const k of ["ethereum", "base", "arbitrum", "optimism", "avalanche", "polygon"] as const) {
    assert.equal(BRIDGE_CHAINS[k].family, "evm");
    assert.equal(typeof BRIDGE_CHAINS[k].chainId, "number");
  }
  assert.equal(BRIDGE_CHAINS.stellar.family, "stellar");
  assert.equal(BRIDGE_CHAINS.solana.family, "solana");
});

test("options order and length 8", () => {
  assert.deepEqual(
    BRIDGE_CHAIN_OPTIONS.map((o) => o.code),
    ["solana", "base", "stellar", "ethereum", "arbitrum", "optimism", "avalanche", "polygon"],
  );
  assert.equal(BRIDGE_CHAIN_OPTIONS.length, 8);
  assert.equal(BRIDGE_CHAIN_OPTIONS[0].name, "Solana");
});

test("bridgeChainByDomain", () => {
  assert.equal(bridgeChainByDomain(27).key, "stellar");
  assert.equal(bridgeChainByDomain(6).key, "base");
  assert.throws(() => bridgeChainByDomain(99));
});

test("explorerTx builds a url containing the hash", () => {
  for (const c of Object.values(BRIDGE_CHAINS)) {
    assert.ok(c.explorerTx("abc123").includes("abc123"), c.key);
  }
});
