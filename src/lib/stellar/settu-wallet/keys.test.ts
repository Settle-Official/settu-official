import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  addUnlockMethod,
  createSealedWallet,
  generateRecoveryCode,
  normalizeRecoveryCode,
  unsealSecret,
} from "./keys";

const PASSWORD = "correct horse battery staple";

test("the password unlocks the secret, and it matches the public key", async () => {
  const { sealed, publicKey } = await createSealedWallet(PASSWORD);
  const secret = await unsealSecret(sealed, {
    type: "password",
    secret: PASSWORD,
  });
  assert.equal(Keypair.fromSecret(secret).publicKey(), publicKey);
});

test("the recovery code unlocks the same secret independently", async () => {
  const { sealed, recoveryCode } = await createSealedWallet(PASSWORD);
  const viaPassword = await unsealSecret(sealed, {
    type: "password",
    secret: PASSWORD,
  });
  const viaRecovery = await unsealSecret(sealed, {
    type: "recovery",
    secret: recoveryCode,
  });
  assert.equal(viaRecovery, viaPassword);
});

test("a wrong password fails closed rather than returning anything", async () => {
  const { sealed } = await createSealedWallet(PASSWORD);
  await assert.rejects(
    () => unsealSecret(sealed, { type: "password", secret: "not it" }),
    /could not unlock/i,
  );
});

test("a wrong recovery code fails closed", async () => {
  const { sealed } = await createSealedWallet(PASSWORD);
  await assert.rejects(
    () =>
      unsealSecret(sealed, { type: "recovery", secret: "AAAAA-BBBBB-CCCCC-DDDDD" }),
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

test("recovery codes are case- and separator-insensitive", async () => {
  const { sealed, recoveryCode } = await createSealedWallet(PASSWORD);
  const messy = recoveryCode.toLowerCase().replace(/-/g, " ");
  const secret = await unsealSecret(sealed, { type: "recovery", secret: messy });
  assert.equal(Keypair.fromSecret(secret).publicKey(), sealed.publicKey);
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
  const viaRecovery = await unsealSecret(updated, {
    type: "recovery",
    secret: created.recoveryCode,
  });

  assert.equal(viaPasskey, viaPassword);
  assert.equal(viaRecovery, viaPassword);
  assert.equal(updated.wraps.length, 3);
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

test("recovery codes are unique and use the unambiguous alphabet", () => {
  const codes = new Set(Array.from({ length: 50 }, generateRecoveryCode));
  assert.equal(codes.size, 50);
  for (const code of codes) {
    assert.match(code, /^[ABCDEFGHJKMNPQRSTVWXYZ23456789-]+$/);
    assert.equal(normalizeRecoveryCode(code).length, 20);
  }
});

test("each wallet gets a distinct keypair", async () => {
  const a = await createSealedWallet(PASSWORD);
  const b = await createSealedWallet(PASSWORD);
  assert.notEqual(a.publicKey, b.publicKey);
  assert.notEqual(a.sealed.ciphertext, b.sealed.ciphertext);
});
