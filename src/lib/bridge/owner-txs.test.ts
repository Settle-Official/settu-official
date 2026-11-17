import { test } from "node:test";
import assert from "node:assert/strict";
import * as StellarSdk from "@stellar/stellar-sdk";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { decodeFunctionData, getAddress, toFunctionSelector } from "viem";
import {
  buildSetLimitTx,
  lowestDeployedCapBps,
  OWNER_LIMITS_ABI,
  OwnerTxError,
  readAllLimits,
  readChainLimits,
  type OwnerTxDeps,
} from "./owner-txs";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";
import type { StellarRpcLike } from "./build-source-tx";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0x52908400098527886E0F7030069857D2E4169EE7";
const BASE_CONTRACT = "0x000000000000000000000000000000000000bEEF";
const ARB_CONTRACT = "0x000000000000000000000000000000000000cAFE";
const G_OWNER = Keypair.random().publicKey();
const STELLAR_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 3));

function fakeStellar(captured: { tx?: StellarSdk.Transaction }): StellarRpcLike {
  return {
    getLatestLedger: async () => ({ sequence: 1000 }),
    getAccount: async (a) => new StellarSdk.Account(a, "42"),
    simulateTransaction: async (tx) => {
      captured.tx = tx;
      return {
        id: "1",
        latestLedger: 1000,
        events: [],
        _parsed: true,
        minResourceFee: "100",
        transactionData: new StellarSdk.SorobanDataBuilder(),
        result: { auth: [], retval: xdr.ScVal.scvVoid() },
      } as unknown as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;
    },
  };
}

function deps(over: Partial<OwnerTxDeps> = {}): Partial<OwnerTxDeps> {
  const contracts: Partial<Record<BridgeChainKey, string>> = {
    base: BASE_CONTRACT,
    arbitrum: ARB_CONTRACT,
    stellar: STELLAR_CONTRACT,
  };
  return {
    contractFor: (c) => contracts[c] ?? null,
    getFeeBps: async (speed) => (speed === "standard" ? 30 : 60),
    readOwner: async (chain) => (chain === "stellar" ? G_OWNER : OWNER),
    readLimit: async (chain, _contract, limit) =>
      limit === "maxFeeBps" ? (chain === "arbitrum" ? BigInt(90) : BigInt(100)) : BigInt(5_000_000),
    stellarServer: () => fakeStellar({}),
    ...over,
  };
}

test("buildSetLimitTx base maxFeeBps 80 encodes setMaxFeeBps(80) to the Base contract", async () => {
  const tx = await buildSetLimitTx("base", "maxFeeBps", BigInt(80), OWNER, deps());
  assert.equal(tx.family, "evm");
  if (tx.family !== "evm") return;
  assert.equal(tx.to, BASE_CONTRACT);
  assert.equal(tx.chainId, BRIDGE_CHAINS.base.chainId);
  assert.equal(tx.data.slice(0, 10), toFunctionSelector("setMaxFeeBps(uint256)"));
  const decoded = decodeFunctionData({ abi: OWNER_LIMITS_ABI, data: tx.data });
  assert.equal(decoded.functionName, "setMaxFeeBps");
  assert.deepEqual(decoded.args, [BigInt(80)]);
});

test("buildSetLimitTx maxNativeFee encodes setMaxNativeFee; maxNetworkFee encodes setMaxNetworkFee", async () => {
  const native = await buildSetLimitTx("base", "maxNativeFee", BigInt(123), OWNER, deps());
  assert.equal(native.family, "evm");
  if (native.family !== "evm") return;
  assert.equal(native.data.slice(0, 10), toFunctionSelector("setMaxNativeFee(uint256)"));
  assert.deepEqual(decodeFunctionData({ abi: OWNER_LIMITS_ABI, data: native.data }).args, [BigInt(123)]);

  const network = await buildSetLimitTx("arbitrum", "maxNetworkFee", BigInt(7), OWNER, deps());
  if (network.family !== "evm") throw new Error("expected evm");
  assert.equal(network.to, getAddress(ARB_CONTRACT));
  assert.equal(network.data.slice(0, 10), toFunctionSelector("setMaxNetworkFee(uint256)"));
});

test("a cap lower than the current fee (either speed) is refused", async () => {
  // fast fee is 60 bps: 50 is below it even though it's above standard (30).
  await assert.rejects(
    buildSetLimitTx("base", "maxFeeBps", BigInt(50), OWNER, deps()),
    (e: unknown) =>
      e instanceof OwnerTxError && e.code === "cap_below_fee" && e.message === "Lower the bridge fee first",
  );
  // Equal to the highest fee is allowed.
  const ok = await buildSetLimitTx("base", "maxFeeBps", BigInt(60), OWNER, deps());
  assert.equal(ok.family, "evm");
});

test("the absolute limits are not gated by the fee", async () => {
  const tx = await buildSetLimitTx("base", "maxNetworkFee", BigInt(0), OWNER, deps());
  assert.equal(tx.family, "evm");
});

test("invalid values are refused", async () => {
  for (const v of [BigInt(-1), BigInt(10_001)]) {
    await assert.rejects(
      buildSetLimitTx("base", "maxFeeBps", v, OWNER, deps()),
      (e: unknown) => e instanceof OwnerTxError && e.code === "invalid_value",
    );
  }
  await assert.rejects(
    buildSetLimitTx("base", "maxNetworkFee", BigInt(-5), OWNER, deps()),
    (e: unknown) => e instanceof OwnerTxError && e.code === "invalid_value",
  );
  // Stellar limits are i128 but the signed quote is u64; keep within i128.
  await assert.rejects(
    buildSetLimitTx("stellar", "maxNativeFee", BigInt(1) << BigInt(127), G_OWNER, deps()),
    (e: unknown) => e instanceof OwnerTxError && e.code === "invalid_value",
  );
});

test("a wallet that isn't the contract owner is refused before building", async () => {
  await assert.rejects(
    buildSetLimitTx("base", "maxFeeBps", BigInt(80), OTHER, deps()),
    (e: unknown) => e instanceof OwnerTxError && e.code === "not_owner",
  );
  await assert.rejects(
    buildSetLimitTx("base", "maxFeeBps", BigInt(80), "not-an-address", deps()),
    (e: unknown) => e instanceof OwnerTxError && e.code === "invalid_owner",
  );
});

test("undeployed chain: build refused with not_deployed (no RPC call)", async () => {
  let called = false;
  await assert.rejects(
    buildSetLimitTx(
      "polygon",
      "maxFeeBps",
      BigInt(80),
      OWNER,
      deps({
        readOwner: async () => {
          called = true;
          return OWNER;
        },
      }),
    ),
    (e: unknown) => e instanceof OwnerTxError && e.code === "not_deployed",
  );
  assert.equal(called, false);
});

test("Solana: build and read both say not available yet", async () => {
  await assert.rejects(
    buildSetLimitTx("solana", "maxFeeBps", BigInt(80), "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", deps()),
    (e: unknown) =>
      e instanceof OwnerTxError && e.code === "not_available" && /not available yet/i.test(e.message),
  );
  const r = await readChainLimits("solana", deps({ contractFor: () => "anything" }));
  assert.equal(r.status, "not_available");
  assert.match(r.status === "not_available" ? r.message : "", /not available yet/i);
});

test("Stellar maxFeeBps builds an unsigned simulated invoke of set_max_fee_bps(u32) from the owner", async () => {
  const captured: { tx?: StellarSdk.Transaction } = {};
  const tx = await buildSetLimitTx(
    "stellar",
    "maxFeeBps",
    BigInt(80),
    G_OWNER,
    deps({ stellarServer: () => fakeStellar(captured) }),
  );
  assert.equal(tx.family, "stellar");
  if (tx.family !== "stellar") return;
  const env = xdr.TransactionEnvelope.fromXDR(tx.xdr, "base64");
  assert.equal(env.v1().signatures().length, 0); // unsigned
  const built = StellarSdk.TransactionBuilder.fromXDR(
    tx.xdr,
    StellarSdk.Networks.TESTNET,
  ) as StellarSdk.Transaction;
  assert.equal(built.source, G_OWNER);
  const op = built.operations[0] as StellarSdk.Operation.InvokeHostFunction;
  const invoke = op.func.invokeContract();
  assert.equal(StrKey.encodeContract(invoke.contractAddress().contractId() as unknown as Buffer), STELLAR_CONTRACT);
  assert.equal(invoke.functionName().toString(), "set_max_fee_bps");
  assert.equal(invoke.args()[0].switch().name, "scvU32");
  assert.equal(invoke.args()[0].u32(), 80);
});

test("Stellar maxNativeFee encodes set_max_native_fee(i128)", async () => {
  const captured: { tx?: StellarSdk.Transaction } = {};
  await buildSetLimitTx(
    "stellar",
    "maxNativeFee",
    BigInt(9_000_000),
    G_OWNER,
    deps({ stellarServer: () => fakeStellar(captured) }),
  );
  const op = captured.tx!.operations[0] as StellarSdk.Operation.InvokeHostFunction;
  const invoke = op.func.invokeContract();
  assert.equal(invoke.functionName().toString(), "set_max_native_fee");
  assert.equal(StellarSdk.scValToNative(invoke.args()[0]), BigInt(9_000_000));
  assert.equal(invoke.args()[0].switch().name, "scvI128");
});

test("readAllLimits covers all 8 chains: undeployed skipped (no RPC), Solana not available", async () => {
  const readChains: string[] = [];
  const rows = await readAllLimits(
    deps({
      readLimit: async (chain, _c, limit) => {
        readChains.push(chain);
        return limit === "maxFeeBps" ? BigInt(chain === "arbitrum" ? 90 : 100) : BigInt(1);
      },
    }),
  );
  assert.equal(rows.length, 8);
  const byChain = Object.fromEntries(rows.map((r) => [r.chain, r]));
  assert.equal(byChain.polygon.status, "not_deployed");
  assert.equal(byChain.ethereum.status, "not_deployed");
  assert.equal(byChain.solana.status, "not_available");
  assert.equal(byChain.base.status, "ok");
  assert.equal(byChain.stellar.status, "ok");
  assert.deepEqual([...new Set(readChains)].sort(), ["arbitrum", "base", "stellar"]);
  assert.equal(lowestDeployedCapBps(rows), 90);
});

test("a deployed chain whose read fails reports error, never throws", async () => {
  const rows = await readAllLimits(
    deps({
      readLimit: async (chain) => {
        if (chain === "base") throw new Error("rpc down");
        return BigInt(100);
      },
    }),
  );
  const base = rows.find((r) => r.chain === "base")!;
  assert.equal(base.status, "error");
  // The lowest cap is unknowable while a deployed chain can't be read.
  assert.equal(lowestDeployedCapBps(rows), null);
});

test("lowestDeployedCapBps: nothing deployed → undefined (caller falls back to env cap)", async () => {
  const rows = await readAllLimits(deps({ contractFor: () => null }));
  assert.ok(rows.every((r) => r.status === "not_deployed" || r.status === "not_available"));
  assert.equal(lowestDeployedCapBps(rows), undefined);
});

test("a misconfigured contract env value is an error row, not a throw", async () => {
  const rows = await readAllLimits(
    deps({
      contractFor: (c) => {
        if (c === "base") throw new Error("BRIDGE_CONTRACT_BASE must be a 0x EVM address");
        return null;
      },
    }),
  );
  assert.equal(rows.find((r) => r.chain === "base")!.status, "error");
});
