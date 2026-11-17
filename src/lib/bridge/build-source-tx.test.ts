import { test } from "node:test";
import assert from "node:assert/strict";
import * as StellarSdk from "@stellar/stellar-sdk";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import {
  ContractFunctionRevertedError,
  decodeFunctionData,
  toFunctionSelector,
  type Hex,
} from "viem";
import {
  buildQuote,
  type BuildQuoteDeps,
  type QuoteRequest,
  type QuoteSuccess,
} from "./build-quote";
import {
  BRIDGE_ABI,
  BRIDGE_FUNCTION_SIGNATURE,
  BuildTxError,
  buildSourceTx,
  permitTypedData,
  STELLAR_APPROVE_LEDGER_OFFSET,
  type BuildSourceTxDeps,
  type StellarRpcLike,
} from "./build-source-tx";
import { TEST_ONLY_ED25519_SEED, TEST_ONLY_EVM_PRIVATE_KEY } from "./quote-vectors.test-helper";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";
import { CCTP_CONFIG } from "../cctp/constants";

const NOW = 1_800_000_000;
const EVM_USER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const EVM_RECIPIENT = "0x52908400098527886E0F7030069857D2E4169EE7";
const G_USER = Keypair.random().publicKey();
const G_RECIPIENT = Keypair.random().publicKey();
const SOL_USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EVM_CONTRACT = "0x000000000000000000000000000000000000bEEF";
const STELLAR_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 3));
const SOLANA_PROGRAM = "BPFLoaderUpgradeab1e11111111111111111111111";

const contracts: Record<BridgeChainKey, string> = {
  stellar: STELLAR_CONTRACT,
  ethereum: EVM_CONTRACT,
  base: EVM_CONTRACT,
  arbitrum: EVM_CONTRACT,
  optimism: EVM_CONTRACT,
  avalanche: EVM_CONTRACT,
  polygon: EVM_CONTRACT,
  solana: SOLANA_PROGRAM,
};

function quoteDeps(over: Partial<BuildQuoteDeps> = {}): Partial<BuildQuoteDeps> {
  return {
    now: () => NOW,
    randomBytes: () => new Uint8Array(32).fill(0xcd),
    getFeeBps: async () => 30,
    maxFeeBps: () => 100,
    getFastFeeBps: async () => 1.3,
    estimateNetworkFee: async () => ({ usdcAtomic: BigInt(630_000), nativeAtomic: BigInt(7_000) }),
    checkDestinationLive: async () => ({ ok: true }),
    nativeBalance: async () => BigInt(10) ** BigInt(20),
    ownGasAllowance: async () => BigInt(0),
    bridgeContractFor: (c) => contracts[c],
    evmSignerKey: () => TEST_ONLY_EVM_PRIVATE_KEY,
    ed25519SignerSecret: () => TEST_ONLY_ED25519_SEED,
    ...over,
  };
}

async function makeQuote(req: Partial<QuoteRequest> = {}): Promise<QuoteSuccess> {
  const r = await buildQuote(
    {
      source: "base",
      dest: "arbitrum",
      amount: "100",
      speed: "standard",
      user: EVM_USER,
      recipient: EVM_RECIPIENT,
      networkFeeMode: "usdc",
      ...req,
    },
    quoteDeps(),
  );
  if ("error" in r) assert.fail(`quote failed: ${r.code}`);
  return r;
}

const stellarQuote = () =>
  makeQuote({ source: "stellar", dest: "base", user: G_USER, recipient: EVM_RECIPIENT });

// ---------------------------------------------------------------- fake Stellar RPC

const LATEST_LEDGER = 5_000;

function fakeStellarServer(over: Partial<StellarRpcLike> = {}) {
  const calls = { simulated: [] as StellarSdk.Transaction[] };
  const server: StellarRpcLike = {
    getLatestLedger: async () => ({ id: "x", sequence: LATEST_LEDGER, protocolVersion: 23 }) as never,
    getAccount: async (g: string) => new StellarSdk.Account(g, "41"),
    simulateTransaction: async (tx) => {
      calls.simulated.push(tx as StellarSdk.Transaction);
      const op = (tx as StellarSdk.Transaction).operations[0] as StellarSdk.Operation.InvokeHostFunction;
      const auth = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            op.func.invokeContract(),
          ),
          subInvocations: [],
        }),
      });
      return {
        _parsed: true,
        id: "1",
        latestLedger: LATEST_LEDGER,
        events: [],
        minResourceFee: "12345",
        transactionData: new StellarSdk.SorobanDataBuilder().setResourceFee(12345),
        result: { auth: [auth], retval: xdr.ScVal.scvVoid() },
      } as never;
    },
    ...over,
  };
  return { server, calls };
}

function deps(over: Partial<BuildSourceTxDeps> = {}): Partial<BuildSourceTxDeps> {
  return {
    now: () => NOW,
    bridgeContractFor: (c) => contracts[c],
    evmAllowance: async () => BigInt(0),
    stellarServer: () => fakeStellarServer().server,
    ...over,
  };
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof BuildTxError, `expected BuildTxError, got ${String(e)}`);
    assert.equal(e.code, code);
    return true;
  });
}

// ---------------------------------------------------------------- ABI

test("hand-written ABI selector matches the Solidity bridge() selector", () => {
  // From `cd contracts/evm && forge inspect SettuBridge methodIdentifiers`
  // (re-run that after any change to bridge()'s signature and paste the line).
  assert.equal(
    BRIDGE_FUNCTION_SIGNATURE,
    "bridge((uint8,uint32,uint32,address,uint256,uint256,uint256,uint256,bytes32,bytes,uint256,uint32,uint64,bytes32),bytes,(uint256,uint256,uint8,bytes32,bytes32,bool))",
  );
  assert.equal(toFunctionSelector(BRIDGE_FUNCTION_SIGNATURE), "0x4f04405f");
  const item = BRIDGE_ABI.find((x) => x.name === "bridge")!;
  assert.equal(toFunctionSelector(item), "0x4f04405f");
});

// ---------------------------------------------------------------- EVM

test("EVM calldata decodes back to the same quote and signature; value = nativeFee (0 in usdc mode)", async () => {
  const q = await makeQuote();
  const tx = await buildSourceTx(q, EVM_USER, {}, deps());
  assert.equal(tx.family, "evm");
  if (tx.family !== "evm") return;
  assert.equal(tx.chainId, BRIDGE_CHAINS.base.chainId);
  assert.equal(tx.to, EVM_CONTRACT);
  assert.equal(tx.value, "0");

  const { functionName, args } = decodeFunctionData({ abi: BRIDGE_ABI, data: tx.data });
  assert.equal(functionName, "bridge");
  const [dq, sig, permit] = args as unknown as [Record<string, unknown>, Hex, Record<string, unknown>];
  assert.deepEqual(
    {
      version: dq.version,
      sourceDomain: dq.sourceDomain,
      destDomain: dq.destDomain,
      user: dq.user,
      amount: (dq.amount as bigint).toString(),
      settuFee: (dq.settuFee as bigint).toString(),
      networkFee: (dq.networkFee as bigint).toString(),
      nativeFee: (dq.nativeFee as bigint).toString(),
      mintRecipient: dq.mintRecipient,
      hookData: dq.hookData,
      maxFee: (dq.maxFee as bigint).toString(),
      minFinality: dq.minFinality,
      deadline: Number(dq.deadline),
      nonce: dq.nonce,
    },
    q.quote,
  );
  assert.equal(sig, q.signature);
  assert.equal(permit.use, false);
  assert.equal(permit.value, BigInt(0));
});

test("EVM native mode: value is nativeFee in wei", async () => {
  const q = await makeQuote({ networkFeeMode: "native" });
  assert.notEqual(q.quote.nativeFee, "0");
  const tx = await buildSourceTx(q, EVM_USER, {}, deps());
  assert.ok(tx.family === "evm");
  assert.equal(tx.value, q.quote.nativeFee);
});

test("EVM needsApproval: allowance below amount and no permit", async () => {
  const q = await makeQuote();
  const amount = BigInt(q.quote.amount);
  let seen: unknown[] = [];
  const low = await buildSourceTx(
    q,
    EVM_USER,
    {},
    deps({
      evmAllowance: async (...a) => {
        seen = a;
        return amount - BigInt(1);
      },
    }),
  );
  assert.ok(low.family === "evm" && low.needsApproval === true);
  assert.deepEqual(seen, ["base", EVM_USER, EVM_CONTRACT]);

  const enough = await buildSourceTx(q, EVM_USER, {}, deps({ evmAllowance: async () => amount }));
  assert.ok(enough.family === "evm" && enough.needsApproval === false);
});

test("EVM with a permit: no approval needed, permit is encoded with use = true", async () => {
  const q = await makeQuote();
  const permit = {
    value: q.quote.amount,
    deadline: String(NOW + 600),
    v: 27,
    r: `0x${"11".repeat(32)}` as Hex,
    s: `0x${"22".repeat(32)}` as Hex,
  };
  const tx = await buildSourceTx(
    q,
    EVM_USER,
    { permit },
    deps({ evmAllowance: async () => assert.fail("allowance must not be read with a permit") }),
  );
  assert.ok(tx.family === "evm");
  assert.equal(tx.needsApproval, false);
  const { args } = decodeFunctionData({ abi: BRIDGE_ABI, data: tx.data });
  const p = (args as unknown as [unknown, unknown, Record<string, unknown>])[2];
  assert.deepEqual(p, {
    value: BigInt(permit.value),
    deadline: BigInt(permit.deadline),
    v: 27,
    r: permit.r,
    s: permit.s,
    use: true,
  });
});

test("EVM rejects a malformed permit or one below the amount", async () => {
  const q = await makeQuote();
  const good = {
    value: q.quote.amount,
    deadline: String(NOW + 600),
    v: 27,
    r: `0x${"11".repeat(32)}` as Hex,
    s: `0x${"22".repeat(32)}` as Hex,
  };
  for (const permit of [
    { ...good, value: (BigInt(q.quote.amount) - BigInt(1)).toString() },
    { ...good, v: 300 },
    { ...good, r: "0x12" as Hex },
    { ...good, deadline: "soon" },
  ]) {
    await rejects(buildSourceTx(q, EVM_USER, { permit }, deps()), "invalid_permit");
  }
});

test("EVM rejects a user address that isn't the quote's user", async () => {
  const q = await makeQuote();
  await rejects(buildSourceTx(q, EVM_RECIPIENT, {}, deps()), "wrong_user");
  // Case differences are the same address.
  const tx = await buildSourceTx(q, EVM_USER.toLowerCase(), {}, deps());
  assert.equal(tx.family, "evm");
});

// ---------------------------------------------------------------- shared checks

test("rejects an expired quote", async () => {
  const q = await makeQuote();
  await rejects(buildSourceTx(q, EVM_USER, {}, deps({ now: () => q.expiresAt })), "quote_expired");
  await rejects(buildSourceTx(q, EVM_USER, {}, deps({ now: () => q.expiresAt + 1 })), "quote_expired");
  const ok = await buildSourceTx(q, EVM_USER, {}, deps({ now: () => q.expiresAt - 1 }));
  assert.equal(ok.family, "evm");
});

test("rejects a quote whose expiresAt disagrees with its signed deadline", async () => {
  const q = await makeQuote();
  await rejects(
    buildSourceTx({ ...q, expiresAt: q.expiresAt + 3600 }, EVM_USER, {}, deps()),
    "invalid_quote",
  );
});

test("rejects a quote bound to a different contract than bridgeContractFor(source)", async () => {
  const q = await makeQuote();
  await rejects(
    buildSourceTx(q, EVM_USER, {}, deps({ bridgeContractFor: () => "0x000000000000000000000000000000000000dEaD" })),
    "contract_mismatch",
  );
  // Checksum/case differences are not a mismatch.
  const tx = await buildSourceTx({ ...q, contract: q.contract.toLowerCase() }, EVM_USER, {}, deps());
  assert.equal(tx.family, "evm");
});

test("rejects malformed quote responses", async () => {
  const q = await makeQuote();
  const bad: unknown[] = [
    null,
    { error: "x", code: "unavailable" },
    { ...q, quote: { ...q.quote, amount: "1e6" } },
    { ...q, quote: { ...q.quote, amount: "-5" } },
    { ...q, quote: { ...q.quote, version: 2 } },
    { ...q, quote: { ...q.quote, nonce: "0x12" } },
    { ...q, quote: { ...q.quote, hookData: "0x1" } },
    { ...q, quote: { ...q.quote, minFinality: 1500 } },
    { ...q, quote: { ...q.quote, sourceDomain: 999 } },
    { ...q, signature: "0x1234" },
    { ...q, contract: 5 },
  ];
  for (const b of bad) {
    await rejects(buildSourceTx(b as QuoteSuccess, EVM_USER, {}, deps()), "invalid_quote");
  }
  await rejects(buildSourceTx(q, 42 as unknown as string, {}, deps()), "invalid_request");
});

test("Solana source is not supported yet", async () => {
  const q = await makeQuote({ source: "solana", dest: "base", user: SOL_USER });
  await assert.rejects(buildSourceTx(q, SOL_USER, {}, deps()), (e: unknown) => {
    assert.ok(e instanceof BuildTxError);
    assert.equal(e.code, "unsupported_source");
    assert.match(e.message, /solana source not supported yet/i);
    return true;
  });
});

// ---------------------------------------------------------------- Stellar

function sortedKeys(m: xdr.ScMapEntry[]) {
  return m.map((e) => e.key().sym().toString());
}

test("Stellar XDR: one invokeHostFunction calling bridge on the bridge contract with the right args", async () => {
  const q = await stellarQuote();
  const { server, calls } = fakeStellarServer();
  const tx = await buildSourceTx(q, G_USER, {}, deps({ stellarServer: () => server }));
  assert.equal(tx.family, "stellar");
  if (tx.family !== "stellar") return;
  assert.equal(calls.simulated.length, 1);

  const parsed = StellarSdk.TransactionBuilder.fromXDR(
    tx.xdr,
    CCTP_CONFIG.stellarNetworkPassphrase,
  ) as StellarSdk.Transaction;
  assert.equal(parsed.source, G_USER);
  assert.equal(parsed.signatures.length, 0, "unsigned");
  assert.equal(parsed.operations.length, 1);
  const op = parsed.operations[0] as StellarSdk.Operation.InvokeHostFunction;
  assert.equal(op.type, "invokeHostFunction");
  // Assembled: the simulated auth tree and soroban data are attached.
  assert.equal(op.auth?.length, 1);
  assert.ok(Number(parsed.fee) >= 12345);

  const call = op.func.invokeContract();
  assert.equal(StrKey.encodeContract(call.contractAddress().contractId() as unknown as Buffer), STELLAR_CONTRACT);
  assert.equal(call.functionName().toString(), "bridge");
  const [userArg, quoteArg, sigArg, expiryArg] = call.args();
  assert.equal(call.args().length, 4);

  assert.equal(StellarSdk.Address.fromScVal(userArg).toString(), G_USER);
  assert.equal(sigArg.switch().name, "scvBytes");
  assert.equal(`0x${Buffer.from(sigArg.bytes()).toString("hex")}`, q.signature);
  assert.equal(expiryArg.switch().name, "scvU32");
  assert.equal(expiryArg.u32(), LATEST_LEDGER + STELLAR_APPROVE_LEDGER_OFFSET);
  assert.equal(STELLAR_APPROVE_LEDGER_OFFSET, 100);

  // QuoteArgs: ScMap with symbol keys in alphabetical order and exact types.
  assert.equal(quoteArg.switch().name, "scvMap");
  const entries = quoteArg.map()!;
  const keys = sortedKeys(entries);
  assert.deepEqual(keys, [
    "amount",
    "deadline",
    "dest_domain",
    "hook_data",
    "max_fee",
    "min_finality",
    "mint_recipient",
    "native_fee",
    "network_fee",
    "nonce",
    "settu_fee",
    "source_domain",
    "user",
  ]);
  assert.deepEqual([...keys].sort(), keys);
  const byKey = Object.fromEntries(entries.map((e) => [e.key().sym().toString(), e.val()]));
  const types = Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, v.switch().name]));
  assert.deepEqual(types, {
    amount: "scvI128",
    deadline: "scvU64",
    dest_domain: "scvU32",
    hook_data: "scvBytes",
    max_fee: "scvI128",
    min_finality: "scvU32",
    mint_recipient: "scvBytes",
    native_fee: "scvI128",
    network_fee: "scvI128",
    nonce: "scvBytes",
    settu_fee: "scvI128",
    source_domain: "scvU32",
    user: "scvBytes",
  });
  const n = (k: string) => String(StellarSdk.scValToNative(byKey[k]));
  const hex = (k: string) => `0x${Buffer.from(byKey[k].bytes()).toString("hex")}`;
  assert.equal(n("amount"), q.quote.amount);
  assert.equal(n("settu_fee"), q.quote.settuFee);
  assert.equal(n("network_fee"), q.quote.networkFee);
  assert.equal(n("native_fee"), q.quote.nativeFee);
  assert.equal(n("max_fee"), q.quote.maxFee);
  assert.equal(n("deadline"), String(q.quote.deadline));
  assert.equal(byKey.source_domain.u32(), q.quote.sourceDomain);
  assert.equal(byKey.dest_domain.u32(), q.quote.destDomain);
  assert.equal(byKey.min_finality.u32(), q.quote.minFinality);
  assert.equal(hex("mint_recipient"), q.quote.mintRecipient);
  assert.equal(hex("nonce"), q.quote.nonce);
  assert.equal(hex("hook_data"), q.quote.hookData);
  assert.equal(hex("user"), `0x${Buffer.from(StrKey.decodeEd25519PublicKey(G_USER)).toString("hex")}`);
});

test("Stellar: non-empty hook_data is passed through byte-for-byte", async () => {
  const q = await stellarQuote();
  const withHook = { ...q, quote: { ...q.quote, hookData: "0xdeadbeef" as const } };
  const tx = await buildSourceTx(withHook, G_USER, {}, deps());
  assert.ok(tx.family === "stellar");
  const parsed = StellarSdk.TransactionBuilder.fromXDR(tx.xdr, CCTP_CONFIG.stellarNetworkPassphrase) as StellarSdk.Transaction;
  const call = (parsed.operations[0] as StellarSdk.Operation.InvokeHostFunction).func.invokeContract();
  const m = call.args()[1].map()!;
  const hook = m.find((e) => e.key().sym().toString() === "hook_data")!.val();
  assert.equal(Buffer.from(hook.bytes()).toString("hex"), "deadbeef");
});

test("Stellar: throws when the burn amount has dust (amount − fees not a multiple of 10)", async () => {
  const q = await stellarQuote();
  const dusty = { ...q, quote: { ...q.quote, settuFee: (BigInt(q.quote.settuFee) + BigInt(3)).toString() } };
  const { server, calls } = fakeStellarServer();
  await assert.rejects(
    buildSourceTx(dusty, G_USER, {}, deps({ stellarServer: () => server })),
    /multiple of 10/,
  );
  assert.equal(calls.simulated.length, 0);
});

test("Stellar: rejects a wrong user, and a simulation failure is a BuildTxError", async () => {
  const q = await stellarQuote();
  await rejects(buildSourceTx(q, G_RECIPIENT, {}, deps()), "wrong_user");
  const { server } = fakeStellarServer({
    simulateTransaction: async () =>
      ({ _parsed: true, id: "1", latestLedger: 1, events: [], error: "HostError: Error(Contract, #9117)" }) as never,
  });
  await rejects(buildSourceTx(q, G_USER, {}, deps({ stellarServer: () => server })), "simulation_failed");
});

test("Stellar: rejects a contract mismatch", async () => {
  const q = await stellarQuote();
  await rejects(
    buildSourceTx(q, G_USER, {}, deps({ bridgeContractFor: () => StrKey.encodeContract(Buffer.alloc(32, 9)) })),
    "contract_mismatch",
  );
});

// ---------------------------------------------------------------- permit typed data

const USDC_BASE = BRIDGE_CHAINS.base.usdc;

function reads(over: Record<string, () => unknown> = {}) {
  const seen: { chain: string; address: string; fn: string; args: unknown[] }[] = [];
  const impl: Record<string, () => unknown> = {
    name: () => "USD Coin",
    version: () => "2",
    nonces: () => BigInt(7),
    ...over,
  };
  return {
    seen,
    deps: {
      bridgeContractFor: (c: BridgeChainKey) => contracts[c],
      readUsdc: async (chain: BridgeChainKey, address: string, fn: "name" | "version" | "nonces", args: unknown[]) => {
        seen.push({ chain, address, fn, args });
        return impl[fn]();
      },
    },
  };
}

test("permitTypedData: EIP-2612 typed data with the on-chain name/version/nonce", async () => {
  const r = reads({ version: () => "2" });
  const td = await permitTypedData("base", EVM_USER, BigInt(100_000_000), BigInt(NOW + 600), r.deps);
  assert.deepEqual(td.domain, {
    name: "USD Coin",
    version: "2",
    chainId: BRIDGE_CHAINS.base.chainId,
    verifyingContract: USDC_BASE,
  });
  assert.equal(td.primaryType, "Permit");
  assert.deepEqual(td.types.Permit, [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ]);
  assert.deepEqual(td.message, {
    owner: EVM_USER,
    spender: EVM_CONTRACT,
    value: BigInt(100_000_000),
    nonce: BigInt(7),
    deadline: BigInt(NOW + 600),
  });
  assert.ok(r.seen.every((s) => s.address === USDC_BASE && s.chain === "base"));
  assert.deepEqual(r.seen.find((s) => s.fn === "nonces")!.args, [EVM_USER]);
});

test("permitTypedData: version falls back to '2' only when version() reverts", async () => {
  const revert = () => {
    throw new ContractFunctionRevertedError({ abi: [], functionName: "version" });
  };
  const td = await permitTypedData("base", EVM_USER, BigInt(1), BigInt(NOW), reads({ version: revert }).deps);
  assert.equal(td.domain.version, "2");

  const outage = () => {
    throw new Error("fetch failed");
  };
  await assert.rejects(
    permitTypedData("base", EVM_USER, BigInt(1), BigInt(NOW), reads({ version: outage }).deps),
    /fetch failed/,
  );
});

test("permitTypedData: refuses non-EVM chains", async () => {
  await assert.rejects(permitTypedData("stellar", G_USER, BigInt(1), BigInt(NOW), reads().deps));
});
