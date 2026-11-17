import test from "node:test";
import assert from "node:assert/strict";
import type { CctpTransferRecord } from "../cctp/cctp-store";
import { registerBridge, getBridgeStatus, toStatusView, BridgeRegisterError } from "./bridge-store";
import { PublicKey } from "@solana/web3.js";
import { TxNotIndexedError, InvalidEventError } from "./read-source-event";
import { BRIDGE_CHAINS } from "./chains";
import type { QuoteRecord } from "./quote-record";
import type { BridgedEvent } from "./read-source-event";

const HASH = "0x" + "cd".repeat(32);
const EV: BridgedEvent = {
  nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
  user: "0x2222222222222222222222222222222222222222",
  amount: BigInt(1_000_000), settuFee: BigInt(5_000), networkFee: BigInt(100), nativeFee: BigInt(0),
  destDomain: 6,
  mintRecipient: ("0x" + "00".repeat(12) + "33".repeat(20)) as `0x${string}`,
  minFinality: 2000,
};

function memDeps(ev: BridgedEvent | null, spy: { creates: number }, quote: QuoteRecord | null = null) {
  const m = new Map<string, CctpTransferRecord>();
  return {
    readEvent: async () => ev,
    get: async (id: string) => m.get(id) ?? null,
    create: async (r: Omit<CctpTransferRecord, "createdAt" | "updatedAt" | "attempts">) => {
      spy.creates++;
      const f = { ...r, attempts: 0, createdAt: 1, updatedAt: 1 } as CctpTransferRecord;
      m.set(r.id, f);
      return f;
    },
    getQuote: async (_n: string) => quote,
    now: () => 0,
  };
}

test("register twice -> one record, onRegistered each time", async () => {
  const spy = { creates: 0 };
  const d = memDeps(EV, spy);
  const calls: string[] = [];
  const a = await registerBridge("base", HASH, async (id) => { calls.push(id); }, d);
  const b = await registerBridge("base", HASH.toUpperCase().replace("0X", "0x"), async (id) => { calls.push(id); }, d);
  assert.equal(spy.creates, 1);
  assert.equal(a.id, b.id);
  assert.equal(calls.length, 2);
});

test("tx without our event -> 400", async () => {
  const d = memDeps(null, { creates: 0 });
  await assert.rejects(registerBridge("base", HASH, undefined, d), (e: unknown) =>
    e instanceof BridgeRegisterError && e.status === 400);
});

test("bad hash -> 400 (EVM and Solana)", async () => {
  const d = memDeps(EV, { creates: 0 });
  await assert.rejects(registerBridge("base", "nope", undefined, d), (e: unknown) => e instanceof BridgeRegisterError && e.status === 400);
  await assert.rejects(registerBridge("solana", "abc", undefined, d), (e: unknown) => e instanceof BridgeRegisterError && e.status === 400);
  await assert.rejects(registerBridge("solana", "0x" + "cd".repeat(32), undefined, d), (e: unknown) => e instanceof BridgeRegisterError && e.status === 400);
});

test("Solana source registers; the base58 signature id keeps its case", async () => {
  const sig = "4Ei2Mz3qkzd1ZgmjhDqWzAWwr6AxaJyTf9B2h8EdkSFMy4nZoBxEGRiTJ8YaNbVjrhN3zgZ7Pv6SXCLWZxkHeeGQ";
  const spy = { creates: 0 };
  const seen: string[] = [];
  const d = {
    ...memDeps({ ...EV, user: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }, spy),
    readEvent: async (_c: string, h: string) => {
      seen.push(h);
      return { ...EV, user: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" };
    },
  };
  const r = await registerBridge("solana", sig, undefined, d);
  assert.equal(r.id, sig);
  assert.equal(r.burnTxHash, sig);
  assert.equal(r.sourceDomain, 5);
  assert.deepEqual(seen, [sig]);
  await registerBridge("solana", sig, undefined, d);
  assert.equal(spy.creates, 1);
  assert.equal((await getBridgeStatus(sig, d))?.id, sig);
});

test("amounts and parties come from the event", async () => {
  const d = memDeps(EV, { creates: 0 });
  const r = await registerBridge("base", HASH, undefined, d);
  assert.equal(r.direction, "bridge");
  assert.equal(r.sourceDomain, BRIDGE_CHAINS.base.cctpDomain);
  assert.equal(r.destDomain, 6);
  assert.equal(r.bridge!.sendAtomic, "1000000");
  assert.equal(r.bridge!.settuFeeAtomic, "5000");
  assert.equal(r.bridge!.networkFeeAtomic, "100");
  assert.equal(r.bridge!.receiveMinAtomic, "994900"); // burn fallback
  assert.equal(r.bridge!.receiveMinIsBurn, true);
  assert.equal(r.bridge!.speed, "standard");
  assert.equal(r.bridge!.dest, "base");
  assert.equal(r.bridge!.recipient?.toLowerCase(), "0x" + "33".repeat(20));
  assert.equal(r.status, "burned");
});

test("fast, no quote record: receiveMin is the burn (amount - fees), flagged", async () => {
  const d = memDeps({ ...EV, minFinality: 1000 }, { creates: 0 });
  const r = await registerBridge("base", HASH, undefined, d);
  assert.equal(r.bridge!.speed, "fast");
  assert.equal(r.bridge!.receiveMinAtomic, "994900");
  assert.equal(r.bridge!.receiveMinIsBurn, true);
});

const QR = (o: Partial<QuoteRecord> = {}): QuoteRecord => ({
  source: "base", dest: "base", speed: "standard", user: EV.user,
  recipient: "0xRecipientExact", maxFeeAtomic: "0", receiveMinAtomic: "990000", ...o,
});

test("quote record present: exact recipient and receiveMin, standard and fast", async () => {
  const s = await registerBridge("base", HASH, undefined, memDeps(EV, { creates: 0 }, QR()));
  assert.equal(s.bridge!.recipient, "0xRecipientExact");
  assert.equal(s.bridge!.receiveMinAtomic, "990000");
  assert.equal(s.bridge!.receiveMinIsBurn, undefined);
  const f = await registerBridge(
    "base", HASH,
    undefined,
    memDeps({ ...EV, minFinality: 1000 }, { creates: 0 }, QR({ speed: "fast", maxFeeAtomic: "4200", receiveMinAtomic: "990700" })),
  );
  assert.equal(f.bridge!.speed, "fast");
  assert.equal(f.bridge!.receiveMinAtomic, "990700");
  assert.equal(f.bridge!.fastFeeMaxAtomic, "4200");
});

test("quote record for a different route/user is ignored", async () => {
  const r = await registerBridge("base", HASH, undefined, memDeps(EV, { creates: 0 }, QR({ user: "0x" + "99".repeat(20) })));
  assert.equal(r.bridge!.receiveMinIsBurn, true);
});

test("fallback recipients: solana ATA base58, stellar unknown", async () => {
  const ata = Buffer.alloc(32, 5);
  const sol = await registerBridge("base", HASH, undefined, memDeps({ ...EV, destDomain: 5, mintRecipient: ("0x" + ata.toString("hex")) as `0x${string}` }, { creates: 0 }));
  assert.equal(sol.bridge!.recipient, new PublicKey(ata).toBase58());
  assert.equal(sol.bridge!.recipientIsTokenAccount, true);
  const st = await registerBridge("base", HASH, undefined, memDeps({ ...EV, destDomain: BRIDGE_CHAINS.stellar.cctpDomain }, { creates: 0 }));
  assert.equal(st.bridge!.recipient, undefined);
  assert.equal(st.bridge!.recipientUnknown, true);
});

test("existing non-bridge record -> 400 not_a_bridge, onRegistered not run", async () => {
  const d = memDeps(EV, { creates: 0 });
  d.get = async () => base({ direction: "onramp", bridge: undefined });
  let ran = false;
  await assert.rejects(registerBridge("base", HASH, async () => { ran = true; }, d), (e: unknown) =>
    e instanceof BridgeRegisterError && e.status === 400 && e.code === "not_a_bridge");
  assert.equal(ran, false);
});

test("not indexed -> 409; invalid event -> 400", async () => {
  const d = memDeps(EV, { creates: 0 });
  d.readEvent = async () => { throw new TxNotIndexedError(); };
  await assert.rejects(registerBridge("base", HASH, undefined, d), (e: unknown) =>
    e instanceof BridgeRegisterError && e.status === 409 && e.code === "not_indexed");
  d.readEvent = async () => { throw new InvalidEventError("x"); };
  await assert.rejects(registerBridge("base", HASH, undefined, d), (e: unknown) =>
    e instanceof BridgeRegisterError && e.status === 400 && e.code === "invalid_event");
});

const base = (o: Partial<CctpTransferRecord>): CctpTransferRecord => ({
  id: HASH, direction: "bridge", sourceDomain: 6, destDomain: 5, burnTxHash: HASH,
  mintRecipient: "0x", status: "burned", attempts: 0, createdAt: 0, updatedAt: 0,
  bridge: { source: "base", dest: "solana", user: "u", recipient: "r", speed: "standard",
    quoteNonce: "n", sendAtomic: "1000000", settuFeeAtomic: "0", networkFeeAtomic: "0",
    fastFeeMaxAtomic: "0", receiveMinAtomic: "990000" },
  ...o,
});

test("status mapping", () => {
  const m = (s: CctpTransferRecord["status"]) => toStatusView(base({ status: s }), 0).status;
  assert.equal(m("burned"), "verifying");
  assert.equal(m("attesting"), "verifying");
  assert.equal(m("attested"), "delivering");
  assert.equal(m("minting"), "delivering");
  assert.equal(m("completed"), "completed");
  assert.equal(m("failed"), "failed");
  const v = toStatusView(base({ status: "completed", mintTxHash: "m" }), 0);
  assert.equal(v.destTx, "m");
  assert.equal(v.sourceTx, HASH);
  assert.equal(v.fellBackToStandard, false);
});

test("canSelfClaim: false at 29 min, true at 30", () => {
  const at = 1_000_000;
  const rec = (status: CctpTransferRecord["status"]) =>
    base({ status, bridge: { ...base({}).bridge!, attestedAt: at } });
  const min = 60_000;
  assert.equal(toStatusView(rec("attested"), at + 29 * min).canSelfClaim, false);
  assert.equal(toStatusView(rec("attested"), at + 30 * min).canSelfClaim, true);
  assert.equal(toStatusView(rec("completed"), at + 60 * min).canSelfClaim, false);
});

test("getBridgeStatus: unknown / non-bridge -> null", async () => {
  const d = memDeps(EV, { creates: 0 });
  assert.equal(await getBridgeStatus("x", d), null);
  assert.equal(await getBridgeStatus("y", { ...d, get: async () => base({ direction: "offramp", bridge: undefined }) }), null);
});

test("canSelfClaim false when attestedAt is undefined", () => {
  assert.equal(toStatusView(base({ status: "attested" }), 10 ** 12).canSelfClaim, false);
});
