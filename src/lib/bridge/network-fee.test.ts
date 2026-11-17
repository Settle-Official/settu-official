import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateNetworkFee,
  NetworkFeeUnavailableError,
  parseCoinbasePrice,
  parseKrakenPrice,
  combinePrices,
  type NetworkFeeDeps,
} from "./network-fee";

function deps(cost: bigint, prices: Record<string, number>): NetworkFeeDeps {
  return {
    gasCostNative: async () => cost,
    nativeUsdPrice: async (c) => prices[c],
  };
}

test("EVM dest 0.0001 ETH at $3000 -> 375000 USDC atomic; solana source $150 -> 2500000 lamports", async () => {
  const r = await estimateNetworkFee("base", "solana", { needsSolanaAta: false },
    deps(BigInt(10) ** BigInt(14), { base: 3000, solana: 150 }));
  assert.equal(r.usdcAtomic, BigInt(375000));
  assert.equal(r.nativeAtomic, BigInt(2500000));
});

test("same-chain EVM source returns wei", async () => {
  const r = await estimateNetworkFee("base", "arbitrum", { needsSolanaAta: false },
    deps(BigInt(10) ** BigInt(14), { base: 3000, arbitrum: 3000 }));
  assert.equal(r.nativeAtomic, BigInt(125) * BigInt(10) ** BigInt(12)); // 0.000125 ETH
});

test("stellar source uses 7 decimals", async () => {
  const r = await estimateNetworkFee("base", "stellar", { needsSolanaAta: false },
    deps(BigInt(10) ** BigInt(14), { base: 3000, stellar: 0.15 }));
  assert.equal(r.nativeAtomic, BigInt(25_000_000)); // 0.375 / 0.15 = 2.5 XLM
});

test("rounds up", async () => {
  const r = await estimateNetworkFee("base", "solana", { needsSolanaAta: false },
    deps(BigInt(1), { base: 3000, solana: 150 }));
  assert.equal(r.usdcAtomic, BigInt(1));
  assert.ok(r.nativeAtomic >= BigInt(1));
});

test("solana dest with ATA includes rent via the gas dep", async () => {
  const withAta = BigInt(10_000) + BigInt(50_000) + BigInt(2_039_280);
  const r = await estimateNetworkFee("solana", "solana", { needsSolanaAta: true },
    deps(withAta, { solana: 100 }));
  // 0.002099280 SOL * $100 * 1.25 = 0.262410 USD
  assert.equal(r.usdcAtomic, BigInt(262410));
});

test("price 0 throws", async () => {
  await assert.rejects(
    estimateNetworkFee("base", "solana", { needsSolanaAta: false }, deps(BigInt(1000), { base: 0, solana: 150 })),
    NetworkFeeUnavailableError);
  await assert.rejects(
    estimateNetworkFee("base", "solana", { needsSolanaAta: false }, deps(BigInt(1000), { base: 3000, solana: 0 })),
    NetworkFeeUnavailableError);
});

test("price or gas rejection throws NetworkFeeUnavailableError", async () => {
  await assert.rejects(
    estimateNetworkFee("base", "base", { needsSolanaAta: false }, {
      gasCostNative: async () => BigInt(1),
      nativeUsdPrice: async () => { throw new Error("boom"); },
    }), NetworkFeeUnavailableError);
  await assert.rejects(
    estimateNetworkFee("base", "base", { needsSolanaAta: false }, {
      gasCostNative: async () => { throw new Error("rpc"); },
      nativeUsdPrice: async () => 3000,
    }), NetworkFeeUnavailableError);
});

test("parse fixtures", () => {
  assert.equal(parseCoinbasePrice({ data: { amount: "1817.49", currency: "USD" } }), 1817.49);
  assert.equal(parseCoinbasePrice({ errors: [] }), null);
  assert.equal(parseKrakenPrice({ error: [], result: { XETHZUSD: { c: ["1817.49000", "0.02"] } } }), 1817.49);
  assert.equal(parseKrakenPrice({ error: ["EQuery:Unknown asset pair"], result: {} }), null);
  assert.equal(parseKrakenPrice({ error: [], result: { SOLUSD: { c: ["0"] } } }), null);
});

test("combinePrices: higher wins, one source ok, none throws, >3% throws", () => {
  assert.equal(combinePrices(100, 102, "x"), 102);
  assert.equal(combinePrices(100, 103, "x"), 103); // exactly 3% allowed
  assert.equal(combinePrices(null, 50, "x"), 50);
  assert.equal(combinePrices(50, null, "x"), 50);
  assert.throws(() => combinePrices(null, null, "x"), NetworkFeeUnavailableError);
  assert.throws(() => combinePrices(100, 103.01, "x"), NetworkFeeUnavailableError);
});
