import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  addUnlockMethod,
  createSealedWallet,
  resealFromMnemonic,
  unsealSecret,
} from "./keys";
import { isValidMnemonic, keypairFromMnemonic } from "./mnemonic";

const PASSWORD = "correct horse battery staple";

test("the password unlocks the secret, and it matches the public key", async () => {
  const { sealed, publicKey } = await createSealedWallet(PASSWORD);
  const secret = await unsealSecret(sealed, {
    type: "password",
    secret: PASSWORD,
  });
  assert.equal(Keypair.fromSecret(secret).publicKey(), publicKey);
});

test("the phrase unlocks the same secret independently", async () => {
  const { sealed, mnemonic } = await createSealedWallet(PASSWORD);
  const viaPassword = await unsealSecret(sealed, {
    type: "password",
    secret: PASSWORD,
  });
  const viaPhrase = await unsealSecret(sealed, {
    type: "mnemonic",
    secret: mnemonic,
  });
  assert.equal(viaPhrase, viaPassword);
});

test("the phrase is 24 valid BIP-39 words", async () => {
  const { mnemonic } = await createSealedWallet(PASSWORD);
  assert.equal(mnemonic.split(" ").length, 24);
  assert.equal(isValidMnemonic(mnemonic), true);
});

test("the phrase recovers the account with the blob deleted entirely", async () => {
  // The point of a phrase over a recovery code: it does not need Settu.
  const { mnemonic, publicKey } = await createSealedWallet(PASSWORD);
  assert.equal(keypairFromMnemonic(mnemonic).publicKey(), publicKey);
});

test("the phrase is accepted despite messy casing and spacing", async () => {
  const { sealed, mnemonic } = await createSealedWallet(PASSWORD);
  const messy = `  ${mnemonic.toUpperCase().replace(/ /g, "   ")}  `;
  const secret = await unsealSecret(sealed, { type: "mnemonic", secret: messy });
  assert.equal(Keypair.fromSecret(secret).publicKey(), sealed.publicKey);
});

test("another wallet's phrase is refused", async () => {
  const a = await createSealedWallet(PASSWORD);
  const b = await createSealedWallet(PASSWORD);
  await assert.rejects(
    () => unsealSecret(a.sealed, { type: "mnemonic", secret: b.mnemonic }),
    /different wallet/i,
  );
});

test("a mistyped phrase is rejected rather than deriving another key", async () => {
  const { sealed } = await createSealedWallet(PASSWORD);
  await assert.rejects(
    () =>
      unsealSecret(sealed, {
        type: "mnemonic",
        secret: "abandon ".repeat(23) + "abandon",
      }),
    /valid|different wallet/i,
  );
});

test("the phrase sets a new password without changing the Stellar key", async () => {
  const { sealed, mnemonic, publicKey } = await createSealedWallet(PASSWORD);
  const resealed = await resealFromMnemonic(mnemonic, "a brand new password!!");

  assert.equal(resealed.publicKey, publicKey);
  const secret = await unsealSecret(resealed, {
    type: "password",
    secret: "a brand new password!!",
  });
  assert.equal(Keypair.fromSecret(secret).publicKey(), publicKey);

  // The old password must not open the new envelope.
  await assert.rejects(() =>
    unsealSecret(resealed, { type: "password", secret: PASSWORD }),
  );
  void sealed;
});

test("a wrong password fails closed rather than returning anything", async () => {
  const { sealed } = await createSealedWallet(PASSWORD);
  await assert.rejects(
    () => unsealSecret(sealed, { type: "password", secret: "not it" }),
    /could not unlock/i,
  );
});

test("the stored blob leaks neither the secret nor the password", async () => {
  const { sealed } = await createSealedWallet(PASSWORD);
  const secret = await unsealSecret(sealed, {
    type: "password",
    secret: PASSWORD,
  });
  const serialized = JSON.stringify(sealed);
  assert.ok(!serialized.includes(secret), "secret must not appear in the blob");
  assert.ok(!serialized.includes(PASSWORD), "password must not appear either");
});

test("the blob carries no key material that could unwrap a DEK server-side", async () => {
  const { sealed } = await createSealedWallet(PASSWORD);
  for (const wrap of sealed.wraps) {
    // Salt and IV are public by design; anything resembling a key is not.
    assert.deepEqual(
      Object.keys(wrap).filter(
        (k) =>
          !["type", "version", "kdf", "iterations", "salt", "iv", "wrappedDek", "label"].includes(k),
      ),
      [],
    );
  }
});

test("adding a passkey wrap leaves the existing ones working", async () => {
  const created = await createSealedWallet(PASSWORD);
  const updated = await addUnlockMethod(
    created.sealed,
    { type: "password", secret: PASSWORD },
    { type: "passkey", secret: "prf-derived-secret", label: "Pixel 8" },
  );

  const viaPasskey = await unsealSecret(updated, {
    type: "passkey",
    secret: "prf-derived-secret",
  });
  const viaPassword = await unsealSecret(updated, {
    type: "password",
    secret: PASSWORD,
  });
  assert.equal(viaPasskey, viaPassword);
  assert.equal(updated.wraps.length, 2);
});

test("a second wrap of the same type does not shadow the first", async () => {
  const created = await createSealedWallet(PASSWORD);
  const updated = await addUnlockMethod(
    created.sealed,
    { type: "password", secret: PASSWORD },
    { type: "passkey", secret: "device-one" },
  );
  const twoDevices = await addUnlockMethod(
    updated,
    { type: "passkey", secret: "device-one" },
    { type: "passkey", secret: "device-two" },
  );

  for (const secret of ["device-one", "device-two"]) {
    const out = await unsealSecret(twoDevices, { type: "passkey", secret });
    assert.equal(Keypair.fromSecret(out).publicKey(), created.publicKey);
  }
});

test("adding a method requires proving an existing one", async () => {
  const { sealed } = await createSealedWallet(PASSWORD);
  await assert.rejects(
    () =>
      addUnlockMethod(
        sealed,
        { type: "password", secret: "wrong" },
        { type: "passkey", secret: "attacker-device" },
      ),
    /could not unlock/i,
  );
});

test("a tampered public key is rejected instead of signing as another account", async () => {
  const { sealed } = await createSealedWallet(PASSWORD);
  const swapped = { ...sealed, publicKey: Keypair.random().publicKey() };
  await assert.rejects(
    () => unsealSecret(swapped, { type: "password", secret: PASSWORD }),
    /integrity/i,
  );
});

test("tampered ciphertext is rejected by AES-GCM rather than decoded", async () => {
  const { sealed } = await createSealedWallet(PASSWORD);
  const bytes = Buffer.from(sealed.ciphertext, "base64");
  bytes[0] ^= 0xff;
  const corrupted = { ...sealed, ciphertext: bytes.toString("base64") };
  await assert.rejects(() =>
    unsealSecret(corrupted, { type: "password", secret: PASSWORD }),
  );
});

test("each wallet gets a distinct keypair", async () => {
  const a = await createSealedWallet(PASSWORD);
  const b = await createSealedWallet(PASSWORD);
  assert.notEqual(a.publicKey, b.publicKey);
  assert.notEqual(a.sealed.ciphertext, b.sealed.ciphertext);
});
