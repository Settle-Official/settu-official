import { test } from "node:test";
import assert from "node:assert/strict";
import { StrKey } from "@stellar/stellar-sdk";
import { bridgeContractFor, feeWalletFor } from "./contracts";

const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";
const SOL = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const C = StrKey.encodeContract(Buffer.alloc(32, 7));
const G = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 9));

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("bridgeContractFor reads BRIDGE_CONTRACT_<CHAIN>", () => {
  withEnv(
    {
      BRIDGE_CONTRACT_BASE: EVM.toLowerCase(),
      BRIDGE_CONTRACT_STELLAR: C,
      BRIDGE_CONTRACT_SOLANA: SOL,
    },
    () => {
      assert.equal(bridgeContractFor("base"), EVM); // checksummed
      assert.equal(bridgeContractFor("stellar"), C);
      assert.equal(bridgeContractFor("solana"), SOL);
    },
  );
});

test("bridgeContractFor throws a clear error when unset", () => {
  withEnv({ BRIDGE_CONTRACT_ARBITRUM: undefined }, () => {
    assert.throws(() => bridgeContractFor("arbitrum"), /BRIDGE_CONTRACT_ARBITRUM is not set/);
  });
  withEnv({ BRIDGE_CONTRACT_ARBITRUM: "   " }, () => {
    assert.throws(() => bridgeContractFor("arbitrum"), /BRIDGE_CONTRACT_ARBITRUM is not set/);
  });
});

test("bridgeContractFor rejects a value of the wrong family", () => {
  withEnv({ BRIDGE_CONTRACT_STELLAR: G, BRIDGE_CONTRACT_BASE: SOL, BRIDGE_CONTRACT_SOLANA: EVM }, () => {
    assert.throws(() => bridgeContractFor("stellar"), /BRIDGE_CONTRACT_STELLAR/);
    assert.throws(() => bridgeContractFor("base"), /BRIDGE_CONTRACT_BASE/);
    assert.throws(() => bridgeContractFor("solana"), /BRIDGE_CONTRACT_SOLANA/);
  });
});

test("feeWalletFor reads FEE_WALLET_<CHAIN> and throws when unset", () => {
  withEnv({ FEE_WALLET_POLYGON: EVM, FEE_WALLET_STELLAR: G, FEE_WALLET_SOLANA: undefined }, () => {
    assert.equal(feeWalletFor("polygon"), EVM);
    assert.equal(feeWalletFor("stellar"), G);
    assert.throws(() => feeWalletFor("solana"), /FEE_WALLET_SOLANA is not set/);
  });
});

test("feeWalletFor rejects a malformed value", () => {
  withEnv({ FEE_WALLET_ETHEREUM: "0x1234", FEE_WALLET_STELLAR: C }, () => {
    assert.throws(() => feeWalletFor("ethereum"), /FEE_WALLET_ETHEREUM/);
    assert.throws(() => feeWalletFor("stellar"), /FEE_WALLET_STELLAR/);
  });
});
