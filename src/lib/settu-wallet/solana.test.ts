import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { addressFromMnemonic, keypairFromMnemonic, signMessage } from "./solana";
import { createMnemonic } from "./mnemonic";
import { keypairFromMnemonic as stellarKeypair } from "./mnemonic";

// The standard BIP-39 test vector, so this is checkable against any wallet.
const VECTOR =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("derivation is deterministic and matches the recorded vector", () => {
  // Phantom's default path (m/44'/501'/0'/0') for this phrase.
  assert.equal(
    addressFromMnemonic(VECTOR),
    "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
  );
  assert.equal(addressFromMnemonic(VECTOR), addressFromMnemonic(VECTOR));
});

test("the address is a valid Solana public key", () => {
  const address = addressFromMnemonic(createMnemonic());
  assert.doesNotThrow(() => new PublicKey(address));
  assert.ok(PublicKey.isOnCurve(new PublicKey(address)));
});

test("one phrase gives distinct keys per chain", () => {
  const phrase = createMnemonic();
  const solana = addressFromMnemonic(phrase);
  const stellar = stellarKeypair(phrase).publicKey();

  assert.notEqual(solana, stellar);
  assert.ok(stellar.startsWith("G"), "Stellar is base32 G-prefixed");
  assert.ok(!solana.startsWith("G") || solana.length !== 56);
});

test("different phrases give different Solana accounts", () => {
  assert.notEqual(
    addressFromMnemonic(createMnemonic()),
    addressFromMnemonic(createMnemonic()),
  );
});

test("casing and spacing are tolerated, as when a phrase is pasted", () => {
  const messy = `  ${VECTOR.toUpperCase().replace(/ /g, "   ")}  `;
  assert.equal(addressFromMnemonic(messy), addressFromMnemonic(VECTOR));
});

test("a mistyped phrase is refused rather than silently deriving", () => {
  assert.throws(
    () => keypairFromMnemonic("abandon abandon not actually a real phrase"),
    /isn't valid/i,
  );
});

test("the signature verifies against the derived address", async () => {
  const nacl = (await import("tweetnacl")).default;
  const bs58 = (await import("bs58")).default;
  const phrase = createMnemonic();
  const keypair = keypairFromMnemonic(phrase);
  const message = "settu wallet challenge";

  // Same check the backend performs: ed25519 over the raw message bytes.
  assert.equal(
    nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      bs58.decode(signMessage(keypair, message)),
      keypair.publicKey.toBytes(),
    ),
    true,
  );
});

test("a signature from another phrase does not verify", async () => {
  const nacl = (await import("tweetnacl")).default;
  const bs58 = (await import("bs58")).default;
  const mine = keypairFromMnemonic(createMnemonic());
  const theirs = keypairFromMnemonic(createMnemonic());
  const message = "settu wallet challenge";

  assert.equal(
    nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      bs58.decode(signMessage(theirs, message)),
      mine.publicKey.toBytes(),
    ),
    false,
  );
});
