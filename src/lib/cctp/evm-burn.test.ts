import test from "node:test";
import assert from "node:assert/strict";
import { usdcFloatToEvmInt, buildEvmBurnCalldata } from "./evm-burn";
import { EVM_SOURCE_CHAINS } from "./evm-chains";

test("usdcFloatToEvmInt converts using 6 decimals, same as Base", () => {
  assert.equal(usdcFloatToEvmInt("1.5"), BigInt(1_500_000));
  assert.equal(usdcFloatToEvmInt("0.000001"), BigInt(1));
  assert.equal(usdcFloatToEvmInt("100"), BigInt(100_000_000));
});

test("buildEvmBurnCalldata includes an approve call when allowance is insufficient", () => {
  const calls = buildEvmBurnCalldata({
    chain: EVM_SOURCE_CHAINS.arbitrum,
    amountFloat: "10",
    mintRecipient: "0x" + "11".repeat(20),
    maxFeeAtomic: BigInt(0),
    currentAllowance: BigInt(0),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].to, EVM_SOURCE_CHAINS.arbitrum.usdcAddress);
  assert.equal(calls[1].to, "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
});

test("buildEvmBurnCalldata skips approve when allowance already covers the amount", () => {
  const calls = buildEvmBurnCalldata({
    chain: EVM_SOURCE_CHAINS.arbitrum,
    amountFloat: "10",
    mintRecipient: "0x" + "11".repeat(20),
    maxFeeAtomic: BigInt(0),
    currentAllowance: BigInt(20_000_000), // 20 USDC, more than the 10 being burned
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
});

test("buildEvmBurnCalldata rejects a direct-kind chain", () => {
  assert.throws(() =>
    buildEvmBurnCalldata({
      chain: EVM_SOURCE_CHAINS.base as any,
      amountFloat: "10",
      mintRecipient: "0x" + "11".repeat(20),
      maxFeeAtomic: BigInt(0),
      currentAllowance: BigInt(0),
    }),
  );
});
