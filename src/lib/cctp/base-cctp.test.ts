import test from "node:test";
import assert from "node:assert/strict";
import {
  bumpFees,
  cctpMessageNonce,
  isNonceTooLowError,
  isUnderpricedError,
  usdcFloatToBaseInt,
} from "./base-cctp";

test("usdcFloatToBaseInt converts using 6 decimals", () => {
  assert.equal(usdcFloatToBaseInt("1"), BigInt(1_000_000));
  assert.equal(usdcFloatToBaseInt("0.5"), BigInt(500_000));
  assert.equal(usdcFloatToBaseInt("12.345678"), BigInt(12_345_678));
});

test("isUnderpricedError matches the replacement rejection, not other failures", () => {
  assert.equal(isUnderpricedError("Details: replacement transaction underpriced"), true);
  assert.equal(isUnderpricedError("transaction underpriced"), true);
  assert.equal(isUnderpricedError("execution reverted: Nonce already used"), false);
  assert.equal(isUnderpricedError("insufficient funds for gas * price + value"), false);
});

test("isNonceTooLowError matches a taken nonce", () => {
  assert.equal(isNonceTooLowError("nonce too low: next nonce 485, tx nonce 484"), true);
  assert.equal(isNonceTooLowError("replacement transaction underpriced"), false);
});

test("bumpFees doubles both fees, clearing the +10% replacement rule", () => {
  const bumped = bumpFees({ maxFeePerGas: BigInt(7_000_000), maxPriorityFeePerGas: BigInt(1_000_000) });
  assert.equal(bumped.maxFeePerGas, BigInt(14_000_000));
  assert.equal(bumped.maxPriorityFeePerGas, BigInt(2_000_000));
});

test("bumpFees never exceeds the 1 gwei cap, and priority never exceeds max", () => {
  const bumped = bumpFees({ maxFeePerGas: BigInt(800_000_000), maxPriorityFeePerGas: BigInt(700_000_000) });
  assert.equal(bumped.maxFeePerGas, BigInt(1_000_000_000));
  assert.equal(bumped.maxPriorityFeePerGas, BigInt(1_000_000_000));
});

test("cctpMessageNonce reads bytes 12-44 of a v2 message", () => {
  // Header of the real Stellar -> Base message from offramp order 81b5d314
  // (2026-11-02); Base's usedNonces returned 1 for this nonce once minted.
  const message =
    "0x000000010000001b00000006" +
    "3b3c295913e8e85a96cc81e94ab140549a68f00f70da5e4bb280a9b6c7f50de2" +
    "09a3773ffd1ff361f8315d629adf17d3e4730fd00a6900715431ed4b142aded2";
  assert.equal(
    cctpMessageNonce(message),
    "0x3b3c295913e8e85a96cc81e94ab140549a68f00f70da5e4bb280a9b6c7f50de2",
  );
  assert.throws(() => cctpMessageNonce("0x00000001"));
});
