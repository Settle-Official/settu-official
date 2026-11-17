import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bridgeCapsGet,
  bridgeCapsPost,
  bridgeCapsSubmitPost,
  bridgeFeeGet,
  bridgeFeePut,
  bridgeListGet,
  bridgeRelayersGet,
  bridgeRevivePost,
  readRelayerBalances,
  selectRecentBridges,
  type BridgeAdminDeps,
} from "./bridge-admin";
import { ADMIN_COOKIE } from "./auth";
import type { ChainLimitsRow } from "../bridge/owner-txs";
import type { CctpTransferRecord } from "../cctp/cctp-store";

// What isAuthorisedAdmin reads off a NextRequest.
function req(auth?: string) {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? auth ?? null : null) },
    cookies: { get: (k: string) => (k === ADMIN_COOKIE ? undefined : undefined) },
  } as never;
}

function explode(): never {
  throw new Error("must not be called without auth");
}

const ALL_EXPLODE: Partial<BridgeAdminDeps> = {
  getFeeBps: explode,
  setFeeBps: explode,
  feeAudit: explode,
  readAllLimits: explode,
  buildSetLimitTx: explode,
  listBridges: explode,
  getBridge: explode,
  revive: explode,
  scheduleDrive: explode,
  recordAction: explode,
  relayerBalances: explode,
  submitStellar: explode,
};

const ok = (rows: Partial<ChainLimitsRow>[]): ChainLimitsRow[] => rows as ChainLimitsRow[];

test("every bridge admin route answers 401 without admin auth (real isAuthorisedAdmin)", async () => {
  const saved = process.env.ADMIN_API_SECRET;
  process.env.ADMIN_API_SECRET = "s".repeat(64);
  try {
    const calls = [
      bridgeFeeGet(req(), ALL_EXPLODE),
      bridgeFeePut(req("Bearer wrong"), { speed: "standard", feeBps: 30, operator: "ann" }, ALL_EXPLODE),
      bridgeCapsGet(req(), ALL_EXPLODE),
      bridgeCapsPost(req(), { chain: "base", limit: "maxFeeBps", value: "80", ownerAddress: "0x" }, ALL_EXPLODE),
      bridgeListGet(req(), null, ALL_EXPLODE),
      bridgeRevivePost(req(), { id: "0xabc", operator: "ann" }, ALL_EXPLODE),
      bridgeRelayersGet(req(), ALL_EXPLODE),
      bridgeCapsSubmitPost(req(), { signedXdr: "AAAA" }, ALL_EXPLODE),
    ];
    for (const r of await Promise.all(calls)) {
      assert.equal(r.status, 401);
      assert.deepEqual(r.body, { error: "Unauthorized", code: "unauthorized" });
    }
  } finally {
    if (saved === undefined) delete process.env.ADMIN_API_SECRET;
    else process.env.ADMIN_API_SECRET = saved;
  }
});

function authed(over: Partial<BridgeAdminDeps> = {}): Partial<BridgeAdminDeps> {
  return {
    isAdmin: () => true,
    recordAction: async () => {},
    getFeeBps: async (s) => (s === "standard" ? 30 : 60),
    feeAudit: async () => [],
    envCapBps: () => 100,
    readAllLimits: async () =>
      ok([
        { chain: "base", status: "ok", maxFeeBps: BigInt(100), maxNetworkFee: BigInt(1), maxNativeFee: BigInt(2) },
        { chain: "polygon", status: "not_deployed" },
        { chain: "solana", status: "not_available", message: "not available yet" },
      ]),
    ...over,
  };
}

test("PUT fee 150 with lowest cap 100 → 400 and nothing written", async () => {
  let wrote = false;
  const r = await bridgeFeePut(
    req(),
    { speed: "fast", feeBps: 150, operator: "Ann" },
    authed({
      setFeeBps: async () => {
        wrote = true;
      },
    }),
  );
  assert.equal(r.status, 400);
  assert.equal((r.body as { code: string }).code, "fee_above_cap");
  assert.equal(wrote, false);
});

test("PUT fee within the lowest cap writes with the operator as actor", async () => {
  const writes: unknown[] = [];
  const r = await bridgeFeePut(
    req(),
    { speed: "standard", feeBps: 40, operator: "  Ann  " },
    authed({
      setFeeBps: async (...a) => {
        writes.push(a);
      },
    }),
  );
  assert.equal(r.status, 200);
  assert.deepEqual(writes, [["standard", 40, "Ann", 100]]);
});

test("PUT fee: lowest cap comes from the lowest deployed chain", async () => {
  const r = await bridgeFeePut(
    req(),
    { speed: "standard", feeBps: 95 , operator: "Ann" },
    authed({
      readAllLimits: async () =>
        ok([
          { chain: "base", status: "ok", maxFeeBps: BigInt(100), maxNetworkFee: BigInt(0), maxNativeFee: BigInt(0) },
          { chain: "arbitrum", status: "ok", maxFeeBps: BigInt(90), maxNetworkFee: BigInt(0), maxNativeFee: BigInt(0) },
        ]),
      setFeeBps: explode,
    }),
  );
  assert.equal(r.status, 400);
  assert.equal((r.body as { code: string }).code, "fee_above_cap");
});

test("PUT fee: nothing deployed → env cap applies", async () => {
  const r = await bridgeFeePut(
    req(),
    { speed: "standard", feeBps: 60, operator: "Ann" },
    authed({
      readAllLimits: async () => ok([{ chain: "base", status: "not_deployed" }]),
      envCapBps: () => 50,
      setFeeBps: explode,
    }),
  );
  assert.equal(r.status, 400);
  assert.equal((r.body as { code: string }).code, "fee_above_cap");
});

test("PUT fee: a deployed chain whose cap can't be read → 503, nothing written", async () => {
  const r = await bridgeFeePut(
    req(),
    { speed: "standard", feeBps: 30, operator: "Ann" },
    authed({
      readAllLimits: async () => ok([{ chain: "base", status: "error", error: "rpc" }]),
      setFeeBps: explode,
    }),
  );
  assert.equal(r.status, 503);
  assert.equal((r.body as { code: string }).code, "cap_unavailable");
});

test("PUT fee: bad input is 400 with a code", async () => {
  const cases: [unknown, string][] = [
    [{ speed: "turbo", feeBps: 30, operator: "Ann" }, "invalid_request"],
    [{ speed: "fast", feeBps: 30.5, operator: "Ann" }, "invalid_fee"],
    [{ speed: "fast", feeBps: "30", operator: "Ann" }, "invalid_fee"],
    [{ speed: "fast", feeBps: 30, operator: " " }, "operator_required"],
    [null, "invalid_request"],
  ];
  for (const [body, code] of cases) {
    const r = await bridgeFeePut(req(), body, authed({ setFeeBps: explode }));
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((r.body as { code: string }).code, code);
  }
});

test("GET fee returns both speeds, audit and the lowest cap", async () => {
  const r = await bridgeFeeGet(
    req(),
    authed({ feeAudit: async () => [{ at: "t", actor: "Ann", speed: "fast", from: 60, to: 50 }] }),
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    standardBps: 30,
    fastBps: 60,
    audit: [{ at: "t", actor: "Ann", speed: "fast", from: 60, to: 50 }],
    lowestCapBps: 100,
    capSource: "chain",
  });
});

test("GET caps serialises bigints and passes not_deployed / not_available rows through", async () => {
  const r = await bridgeCapsGet(req(), authed());
  assert.equal(r.status, 200);
  const body = r.body as { chains: Record<string, unknown>[]; fee: unknown };
  assert.deepEqual(body.chains[0], {
    chain: "base",
    status: "ok",
    label: "Base",
    family: "evm",
    nativeSymbol: "ETH",
    maxFeeBps: "100",
    maxNetworkFee: "1",
    maxNativeFee: "2",
  });
  assert.equal(body.chains[1].status, "not_deployed");
  assert.equal(body.chains[2].status, "not_available");
  assert.deepEqual(body.fee, { standardBps: 30, fastBps: 60 });
});

test("POST caps: OwnerTxError → 400 with its code; bad value → 400", async () => {
  const { OwnerTxError } = await import("../bridge/owner-txs");
  const r = await bridgeCapsPost(
    req(),
    { chain: "base", limit: "maxFeeBps", value: "20", ownerAddress: "0x1", operator: "Ann" },
    authed({
      buildSetLimitTx: async () => {
        throw new OwnerTxError("cap_below_fee", "Lower the bridge fee first");
      },
    }),
  );
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: "Lower the bridge fee first", code: "cap_below_fee" });

  const bad = await bridgeCapsPost(
    req(),
    { chain: "base", limit: "maxFeeBps", value: "1.5", ownerAddress: "0x1", operator: "Ann" },
    authed({ buildSetLimitTx: explode }),
  );
  assert.equal(bad.status, 400);
  const badChain = await bridgeCapsPost(
    req(),
    { chain: "nope", limit: "maxFeeBps", value: "1", ownerAddress: "0x1", operator: "Ann" },
    authed({ buildSetLimitTx: explode }),
  );
  assert.equal(badChain.status, 400);
});

test("POST caps: unexpected failure → 503 without leaking the message", async () => {
  const r = await bridgeCapsPost(
    req(),
    { chain: "base", limit: "maxFeeBps", value: "80", ownerAddress: "0x1", operator: "Ann" },
    authed({
      buildSetLimitTx: async () => {
        throw new Error("secret rpc url https://key@node");
      },
    }),
  );
  assert.equal(r.status, 503);
  assert.doesNotMatch(JSON.stringify(r.body), /secret|key@/);
});

const row = (status: CctpTransferRecord["status"]) => ({
  id: "0xabc",
  status: status === "failed" ? "failed" : "verifying",
  recordStatus: status,
  source: "base",
  dest: "stellar",
  sendAtomic: "1",
  receiveMinAtomic: "1",
  sourceTx: "0xabc",
  canSelfClaim: false,
  fellBackToStandard: false,
  attempts: 20,
  createdAt: 1,
  updatedAt: 2,
  speed: "standard" as const,
});

test("revive: failed bridge → reviveStuckTransfer, then scheduleDrive, audited", async () => {
  const seq: string[] = [];
  const r = await bridgeRevivePost(
    req(),
    { id: "0xABC", operator: "Ann" },
    authed({
      getBridge: async (id) => {
        seq.push(`get:${id}`);
        return row(seq.length > 1 ? "burned" : "failed") as never;
      },
      revive: async (id) => {
        seq.push(`revive:${id}`);
        return { ok: true, message: "revived", status: "burned" };
      },
      scheduleDrive: async (id) => {
        seq.push(`schedule:${id}`);
      },
      recordAction: async (e) => {
        seq.push(`audit:${e.action}:${e.operator}:${e.outcome}`);
      },
    }),
  );
  assert.equal(r.status, 200);
  assert.deepEqual(seq.slice(0, 3), ["get:0xabc", "revive:0xabc", "schedule:0xabc"]);
  assert.ok(seq.includes("audit:bridge-revive:Ann:revived"));
});

test("revive: refuses a bridge that isn't failed (409), unknown id (404), no operator (400)", async () => {
  const notFailed = await bridgeRevivePost(
    req(),
    { id: "0xabc", operator: "Ann" },
    authed({ getBridge: async () => row("attested") as never, revive: explode, scheduleDrive: explode }),
  );
  assert.equal(notFailed.status, 409);
  const missing = await bridgeRevivePost(
    req(),
    { id: "0xabc", operator: "Ann" },
    authed({ getBridge: async () => null, revive: explode }),
  );
  assert.equal(missing.status, 404);
  const anon = await bridgeRevivePost(req(), { id: "0xabc" }, authed({ getBridge: explode }));
  assert.equal(anon.status, 400);
});

test("list: by id returns that one; otherwise recent", async () => {
  const one = await bridgeListGet(req(), "0xABC", authed({ getBridge: async (id) => ({ ...row("failed"), id }) as never }));
  assert.equal(one.status, 200);
  assert.equal((one.body as { bridges: { id: string }[] }).bridges[0].id, "0xabc");
  const recent = await bridgeListGet(req(), null, authed({ listBridges: async () => [row("burned") as never] }));
  assert.equal((recent.body as { bridges: unknown[] }).bridges.length, 1);
});

test("selectRecentBridges keeps only bridge records, newest first, capped", () => {
  const rec = (id: string, createdAt: number, direction: CctpTransferRecord["direction"] = "bridge") =>
    ({
      id,
      direction,
      createdAt,
      updatedAt: createdAt,
      status: "burned",
      attempts: 0,
      burnTxHash: id,
      sourceDomain: 6,
      destDomain: 27,
      mintRecipient: "0x",
      ...(direction === "bridge"
        ? {
            bridge: {
              source: "base",
              dest: "stellar",
              user: "0x",
              speed: "standard",
              quoteNonce: "0x",
              sendAtomic: "1",
              settuFeeAtomic: "0",
              networkFeeAtomic: "0",
              fastFeeMaxAtomic: "0",
              receiveMinAtomic: "1",
            },
          }
        : {}),
    }) as CctpTransferRecord;
  const out = selectRecentBridges([rec("a", 1), rec("b", 3), rec("o", 5, "onramp"), null, rec("c", 2)], 2);
  assert.deepEqual(out.map((r) => r.id), ["b", "c"]);
  assert.equal(out[0].recordStatus, "burned");
});

test("relayer balances: unset → not_configured with no RPC; failures are per-row errors", async () => {
  let rpc = 0;
  const rows = await readRelayerBalances({
    env: (k) => ({ BRIDGE_EVM_RELAYER_ADDRESS: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" })[k],
    evmBalance: async (chain) => {
      rpc++;
      if (chain === "polygon") throw new Error("rpc down");
      return BigInt("1500000000000000000");
    },
    stellarBalance: async () => {
      rpc++;
      return BigInt(1);
    },
    solanaBalance: async () => {
      rpc++;
      return BigInt(1);
    },
  });
  assert.equal(rows.length, 8);
  const by = Object.fromEntries(rows.map((r) => [r.chain, r]));
  assert.equal(by.stellar.status, "not_configured");
  assert.equal(by.solana.status, "not_configured");
  assert.equal(by.base.status, "ok");
  assert.equal(by.base.balanceAtomic, "1500000000000000000");
  assert.equal(by.base.decimals, 18);
  assert.equal(by.polygon.status, "error");
  assert.equal(rpc, 6);
});

test("POST caps records a bridge-limit-build audit entry; requires an operator", async () => {
  const entries: unknown[] = [];
  const r = await bridgeCapsPost(
    req(),
    { chain: "base", limit: "maxNativeFee", value: "123", ownerAddress: "0x1", operator: "Ann" },
    authed({
      buildSetLimitTx: async () => ({ family: "evm", chainId: 8453, to: "0x1" as never, data: "0x" }),
      recordAction: async (e) => {
        entries.push(e);
      },
    }),
  );
  assert.equal(r.status, 200);
  assert.deepEqual(entries, [
    { action: "bridge-limit-build", orderId: "base", operator: "Ann", outcome: "built", detail: "maxNativeFee=123" },
  ]);

  const anon = await bridgeCapsPost(
    req(),
    { chain: "base", limit: "maxNativeFee", value: "123", ownerAddress: "0x1" },
    authed({ buildSetLimitTx: explode }),
  );
  assert.equal(anon.status, 400);
  assert.equal((anon.body as { code: string }).code, "operator_required");
});

test("POST caps/submit sends the signed XDR to the configured (testnet-aware) Stellar RPC", async () => {
  const { CCTP_CONFIG } = await import("../cctp/constants");
  const sent: [string, string][] = [];
  const r = await bridgeCapsSubmitPost(
    req(),
    { signedXdr: "AAAAsigned" },
    authed({
      stellarRpcUrl: () => CCTP_CONFIG.stellarRpcUrl,
      submitStellar: async (url, x) => {
        sent.push([url, x]);
        return { hash: "ab".repeat(32), status: "PENDING" };
      },
    }),
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { hash: "ab".repeat(32), status: "PENDING" });
  assert.deepEqual(sent, [[CCTP_CONFIG.stellarRpcUrl, "AAAAsigned"]]);
});

test("POST caps/submit: default RPC url is CCTP_CONFIG.stellarRpcUrl; rejection → 400; bad body → 400", async () => {
  const { CCTP_CONFIG } = await import("../cctp/constants");
  const { defaultBridgeAdminDeps } = await import("./bridge-admin");
  assert.equal(defaultBridgeAdminDeps().stellarRpcUrl(), CCTP_CONFIG.stellarRpcUrl);

  const rejected = await bridgeCapsSubmitPost(
    req(),
    { signedXdr: "AAAA" },
    authed({ submitStellar: async () => ({ hash: "x", status: "ERROR" }) }),
  );
  assert.equal(rejected.status, 400);
  assert.equal((rejected.body as { code: string }).code, "submit_failed");

  const bad = await bridgeCapsSubmitPost(req(), { signedXdr: "" }, authed({ submitStellar: explode }));
  assert.equal(bad.status, 400);
});
