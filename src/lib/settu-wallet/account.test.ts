import test from "node:test";
import assert from "node:assert/strict";
import { Account, Asset, Keypair, Operation } from "@stellar/stellar-sdk";
import {
  STELLAR_USDC,
  STELLAR_USDC_ISSUER,
  buildSponsoredCreationTx,
  buildSponsoredTrustlineTx,
  isSafeToSponsor,
} from "./account";

const SPONSOR = "GAVGBW4T6XQUZW7JD2JMVSVEHM72Q7OTCWSSQQDJQ56YAJ7L3HXFBB4N";
const sponsorAccount = () => new Account(SPONSOR, "1");
const newAccount = () => Keypair.random().publicKey();

test("USDC is pinned to Circle's issuer", () => {
  assert.equal(STELLAR_USDC.getCode(), "USDC");
  assert.equal(STELLAR_USDC.getIssuer(), STELLAR_USDC_ISSUER);
});

test("creation wraps everything in a sponsorship the sponsor pays for", () => {
  const account = newAccount();
  const tx = buildSponsoredCreationTx({
    sponsor: sponsorAccount(),
    newAccountPublicKey: account,
  });

  const types = tx.operations.map((op) => op.type);
  assert.deepEqual(types, [
    "beginSponsoringFutureReserves",
    "createAccount",
    "changeTrust",
    "endSponsoringFutureReserves",
  ]);
  assert.equal(tx.source, SPONSOR);
});

test("the new account is funded with zero XLM — the reserve is sponsored", () => {
  const account = newAccount();
  const tx = buildSponsoredCreationTx({
    sponsor: sponsorAccount(),
    newAccountPublicKey: account,
  });
  const create = tx.operations.find((op) => op.type === "createAccount");
  assert.ok(create && create.type === "createAccount");
  // Stellar normalises to 7 decimal places, so compare the value not the text.
  assert.equal(Number(create.startingBalance), 0);
  assert.equal(create.destination, account);
});

test("operations that consume the sponsorship are sourced from the new account", () => {
  const account = newAccount();
  const tx = buildSponsoredCreationTx({
    sponsor: sponsorAccount(),
    newAccountPublicKey: account,
  });

  for (const op of tx.operations) {
    if (op.type === "changeTrust" || op.type === "endSponsoringFutureReserves") {
      assert.equal(op.source, account, `${op.type} must be the new account's`);
    }
  }
});

test("extra assets each get their own trustline inside the sponsorship", () => {
  const account = newAccount();
  const eurc = new Asset("EURC", STELLAR_USDC_ISSUER);
  const tx = buildSponsoredCreationTx({
    sponsor: sponsorAccount(),
    newAccountPublicKey: account,
    assets: [STELLAR_USDC, eurc],
  });

  const trustlines = tx.operations.filter((op) => op.type === "changeTrust");
  assert.equal(trustlines.length, 2);
  // Sponsorship must still close after the last one.
  assert.equal(
    tx.operations[tx.operations.length - 1].type,
    "endSponsoringFutureReserves",
  );
});

test("a later trustline is sponsored without recreating the account", () => {
  const account = newAccount();
  const tx = buildSponsoredTrustlineTx({
    sponsor: sponsorAccount(),
    accountPublicKey: account,
    asset: STELLAR_USDC,
  });

  assert.deepEqual(
    tx.operations.map((op) => op.type),
    [
      "beginSponsoringFutureReserves",
      "changeTrust",
      "endSponsoringFutureReserves",
    ],
  );
});

test("what we build is accepted by the sponsor guard", () => {
  const account = newAccount();
  for (const tx of [
    buildSponsoredCreationTx({
      sponsor: sponsorAccount(),
      newAccountPublicKey: account,
    }),
    buildSponsoredTrustlineTx({
      sponsor: sponsorAccount(),
      accountPublicKey: account,
      asset: STELLAR_USDC,
    }),
  ]) {
    assert.equal(isSafeToSponsor(tx, account), true);
  }
});

test("the guard refuses a payment smuggled in beside the sponsorship", () => {
  const account = newAccount();
  const attacker = Keypair.random().publicKey();
  const tx = buildSponsoredCreationTx({
    sponsor: sponsorAccount(),
    newAccountPublicKey: account,
  });

  const smuggled = new (tx.constructor as typeof import("@stellar/stellar-sdk").Transaction)(
    tx.toEnvelope(),
    tx.networkPassphrase,
  );
  // Rebuild the operation list with a payment appended.
  const withPayment = {
    ...smuggled,
    operations: [
      ...smuggled.operations,
      Operation.payment({
        destination: attacker,
        asset: STELLAR_USDC,
        amount: "100",
      }),
    ],
  } as unknown as import("@stellar/stellar-sdk").Transaction;

  assert.equal(isSafeToSponsor(withPayment, account), false);
});

test("the guard refuses sponsoring an account other than the one named", () => {
  const account = newAccount();
  const someoneElse = newAccount();
  const tx = buildSponsoredCreationTx({
    sponsor: sponsorAccount(),
    newAccountPublicKey: account,
  });
  assert.equal(isSafeToSponsor(tx, someoneElse), false);
});
