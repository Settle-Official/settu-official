import { test } from "node:test";
import assert from "node:assert/strict";
import { MAINNET_PASSPHRASE, TESTNET_PASSPHRASE, resolveSignOptions } from "./sign-options";

test("default sign options stay mainnet (existing offramp callers pass nothing)", () => {
  assert.equal(MAINNET_PASSPHRASE, "Public Global Stellar Network ; September 2015");
  assert.deepEqual(resolveSignOptions(), {
    networkPassphrase: MAINNET_PASSPHRASE,
    wcChainId: "stellar:pubnet",
  });
  assert.deepEqual(resolveSignOptions(undefined), resolveSignOptions());
});

test("an explicit testnet passphrase is forwarded to the kit and the WalletConnect chain", () => {
  assert.equal(TESTNET_PASSPHRASE, "Test SDF Network ; September 2015");
  assert.deepEqual(resolveSignOptions(TESTNET_PASSPHRASE), {
    networkPassphrase: TESTNET_PASSPHRASE,
    wcChainId: "stellar:testnet",
  });
});
