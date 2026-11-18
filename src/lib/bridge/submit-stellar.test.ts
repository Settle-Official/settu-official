import test from "node:test";
import assert from "node:assert/strict";
import * as StellarSdk from "@stellar/stellar-sdk";

import { submitStellarBridgeTx, SubmitStellarError, type SubmitStellarDeps } from "./submit-stellar";

const PASSPHRASE = StellarSdk.Networks.TESTNET;
const BRIDGE = "CDN4JIXDFJXUYIPQB22NLQ3VGD43IYSLEUEI727BHWJVPLYQ5QD3V4CM";
const OTHER = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function signedXdr(contractId: string, fn = "bridge"): string {
  const kp = StellarSdk.Keypair.random();
  const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(kp.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new StellarSdk.Contract(contractId).call(fn, StellarSdk.nativeToScVal(1, { type: "u32" })))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  return tx.toXDR();
}

function deps(over: Partial<SubmitStellarDeps> = {}): SubmitStellarDeps & { sent: number } {
  const d = {
    sent: 0,
    passphrase: () => PASSPHRASE,
    bridgeContract: () => BRIDGE,
    send: async () => {
      d.sent++;
      return { hash: "abc", status: "PENDING" };
    },
    getStatus: async () => "SUCCESS",
    sleep: async () => {},
    ...over,
  };
  return d;
}

test("submits a signed call to Settu's bridge contract and waits for SUCCESS", async () => {
  const d = deps();
  assert.deepEqual(await submitStellarBridgeTx(signedXdr(BRIDGE), d), { hash: "abc" });
  assert.equal(d.sent, 1);
});

test("refuses a transaction that calls any other contract (no open relay)", async () => {
  const d = deps();
  await assert.rejects(submitStellarBridgeTx(signedXdr(OTHER), d), (e: unknown) =>
    e instanceof SubmitStellarError && e.code === "not_a_bridge");
  assert.equal(d.sent, 0);
});

test("refuses another function on the bridge contract", async () => {
  await assert.rejects(submitStellarBridgeTx(signedXdr(BRIDGE, "set_signer"), deps()), (e: unknown) =>
    e instanceof SubmitStellarError && e.code === "not_a_bridge");
});

test("refuses garbage", async () => {
  await assert.rejects(submitStellarBridgeTx("not-xdr", deps()), (e: unknown) =>
    e instanceof SubmitStellarError && e.code === "invalid_tx");
});

test("an ERROR from sendTransaction or a FAILED result is reported, not retried", async () => {
  await assert.rejects(
    submitStellarBridgeTx(signedXdr(BRIDGE), deps({ send: async () => ({ hash: "abc", status: "ERROR" }) })),
    (e: unknown) => e instanceof SubmitStellarError && e.code === "rejected",
  );
  await assert.rejects(
    submitStellarBridgeTx(signedXdr(BRIDGE), deps({ getStatus: async () => "FAILED" })),
    (e: unknown) => e instanceof SubmitStellarError && e.code === "failed",
  );
});

test("still pending after the wait returns the hash anyway (the sweep follows it)", async () => {
  const r = await submitStellarBridgeTx(signedXdr(BRIDGE), deps({ getStatus: async () => "NOT_FOUND" }));
  assert.deepEqual(r, { hash: "abc" });
});
