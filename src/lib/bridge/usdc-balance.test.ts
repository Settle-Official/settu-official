import test from "node:test";
import assert from "node:assert/strict";

import { readUsdcBalance, STELLAR_USDC_ISSUER, type UsdcBalanceDeps } from "./usdc-balance";
import { BRIDGE_CHAINS } from "./chains";

function deps(over: Partial<UsdcBalanceDeps> = {}): UsdcBalanceDeps {
  return {
    evmBalanceOf: async () => BigInt(0),
    stellarBalances: async () => [],
    solanaTokenAmounts: async () => [],
    ...over,
  };
}

test("EVM reads balanceOf on that chain's USDC and returns 6-decimal atomic", async () => {
  let seen: unknown[] = [];
  const r = await readUsdcBalance("base", "0xa894a3B6fBf182D2D24Fff808B81De849cF7B41c", deps({
    evmBalanceOf: async (chain, token, owner) => {
      seen = [chain, token, owner];
      return BigInt(12_345_678);
    },
  }));
  assert.deepEqual(seen, ["base", BRIDGE_CHAINS.base.usdc, "0xa894a3B6fBf182D2D24Fff808B81De849cF7B41c"]);
  assert.deepEqual(r, { atomic: "12345678", decimals: 6 });
});

test("Stellar counts only Circle's USDC, in 7 decimals", async () => {
  const r = await readUsdcBalance("stellar", "GD6YGF422FQSOH2RJMV5WUUFGGGCFKK4TKK6SO3EQES477NBCG2VBDSI", deps({
    stellarBalances: async () => [
      { asset_type: "native", balance: "100.0000000" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GFAKEISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", balance: "999.0000000" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: STELLAR_USDC_ISSUER, balance: "25.5000000" },
    ],
  }));
  assert.deepEqual(r, { atomic: "255000000", decimals: 7 });
});

test("a Stellar account with no USDC trustline, or no account, is zero", async () => {
  const r = await readUsdcBalance("stellar", "GD6YGF422FQSOH2RJMV5WUUFGGGCFKK4TKK6SO3EQES477NBCG2VBDSI", deps({
    stellarBalances: async () => null,
  }));
  assert.deepEqual(r, { atomic: "0", decimals: 7 });
});

test("Solana sums every token account for the USDC mint", async () => {
  let mint = "";
  const r = await readUsdcBalance("solana", "7SWdeT5NiwDtbhEmZom9ZmbYWFE5vdsjwqHzgHF3jfyf", deps({
    solanaTokenAmounts: async (_owner, m) => {
      mint = m;
      return [BigInt(1_000_000), BigInt(500_000)];
    },
  }));
  assert.equal(mint, BRIDGE_CHAINS.solana.usdc);
  assert.deepEqual(r, { atomic: "1500000", decimals: 6 });
});
