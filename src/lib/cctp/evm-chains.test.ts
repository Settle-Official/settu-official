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

// --- Arc -------------------------------------------------------------------
import { decodeFunctionData } from "viem";
import { effectiveGasPrice, gasCoverage, sourceChainByChainId } from "./evm-chains";
import { buildEvmBurnCalldata } from "./evm-burn";

const arc = EVM_SOURCE_CHAINS.arc;
const GWEI = BigInt(1_000_000_000);
const usdc18 = (n: number) => BigInt(Math.round(n * 1e6)) * BigInt(1_000_000_000_000);

test("Arc is a CCTP-bridge chain on domain 26 with its verified addresses", () => {
  assert.ok(isCctpBridgeChain(arc));
  if (!isCctpBridgeChain(arc)) return;
  assert.equal(arc.chainId, 5042);
  assert.equal(arc.cctpDomain, 26);
  assert.equal(arc.usdcAddress, "0x3600000000000000000000000000000000000000");
  assert.equal(arc.nativeCurrencySymbol, "USDC");
  assert.equal(arc.fastTransfer, false);
  assert.equal(arc.gasIsUsdc, true);
  assert.equal(arc.addToWallet?.nativeCurrency.decimals, 18);
  assert.equal(sourceChainByChainId(5042), arc);
});

test("CCTP domains stay unique with Arc added", () => {
  const domains = Object.values(EVM_SOURCE_CHAINS).filter(isCctpBridgeChain).map((c) => c.cctpDomain);
  assert.equal(new Set(domains).size, domains.length);
});

test("Arc gas price never drops below its 20 gwei floor; other chains are untouched", () => {
  assert.equal(effectiveGasPrice(arc, GWEI), BigInt(20) * GWEI);
  assert.equal(effectiveGasPrice(arc, BigInt(25) * GWEI), BigInt(25) * GWEI);
  assert.equal(effectiveGasPrice(EVM_SOURCE_CHAINS.arbitrum, BigInt(1)), BigInt(1));
});

test("on Arc the amount and its gas come out of the same USDC balance", () => {
  const gas = usdc18(0.01);
  // 10 USDC balance, sending 9.99 → exactly 0.01 left for gas.
  assert.deepEqual(gasCoverage({ config: arc, nativeBalanceWei: usdc18(10), gasWei: gas, amountAtomic: BigInt(9_990_000) }),
    { sufficient: true, availableForGasWei: gas });
  // Sending the whole 10 → nothing left for gas.
  const all = gasCoverage({ config: arc, nativeBalanceWei: usdc18(10), gasWei: gas, amountAtomic: BigInt(10_000_000) });
  assert.equal(all.sufficient, false);
  assert.equal(all.availableForGasWei, BigInt(0));
  // Elsewhere the native balance is separate from the USDC amount.
  const arb = gasCoverage({ config: EVM_SOURCE_CHAINS.arbitrum, nativeBalanceWei: gas, gasWei: gas, amountAtomic: BigInt(10_000_000) });
  assert.equal(arb.sufficient, true);
});

test("an Arc burn uses standard finality and Arc's own USDC", () => {
  const calls = buildEvmBurnCalldata({
    chain: arc,
    amountFloat: "5",
    mintRecipient: "0x1111111111111111111111111111111111111111",
    maxFeeAtomic: BigInt(0),
    currentAllowance: BigInt(10_000_000),
    fast: arc.kind === "cctp-bridge" && arc.fastTransfer !== false,
  });
  assert.equal(calls.length, 1);
  const { args } = decodeFunctionData({
    abi: [{ type: "function", name: "depositForBurn", stateMutability: "nonpayable", outputs: [], inputs: [
      { name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" }, { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" }, { name: "destinationCaller", type: "bytes32" }, { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" } ] }] as const,
    data: calls[0].data,
  });
  assert.equal(args[0], BigInt(5_000_000));
  assert.equal(args[1], 6); // Base
  assert.equal((args[3] as string).toLowerCase(), "0x3600000000000000000000000000000000000000");
  assert.equal(args[5], BigInt(0));
  assert.equal(args[6], 2000); // standard
});
