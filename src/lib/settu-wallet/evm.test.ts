import test from "node:test";
import assert from "node:assert/strict";
import { recoverMessageAddress, isAddress, getAddress } from "viem";
import { accountFromMnemonic, addressFromMnemonic, signMessage } from "./evm";
import { createMnemonic, keypairFromMnemonic as stellarKeypair } from "./mnemonic";
import { addressFromMnemonic as solanaAddress } from "./solana";

// The standard BIP-39 vector; this address is the one every EVM tool derives
// from it, so the path is checkable outside this codebase.
const VECTOR =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VECTOR_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

test("derivation matches the canonical address for the vector", () => {
  assert.equal(addressFromMnemonic(VECTOR), VECTOR_ADDRESS);
});

test("the address is a valid checksummed EVM address", () => {
  const address = addressFromMnemonic(createMnemonic());
  assert.ok(isAddress(address));
  assert.equal(address, getAddress(address));
});

test("one phrase gives three distinct chain identities", () => {
  const phrase = createMnemonic();
  const evm = addressFromMnemonic(phrase).toLowerCase();
  const solana = solanaAddress(phrase);
  const stellar = stellarKeypair(phrase).publicKey();

  assert.equal(new Set([evm, solana, stellar]).size, 3);
  assert.ok(evm.startsWith("0x"));
  assert.ok(stellar.startsWith("G"));
});

test("casing and spacing are tolerated, as when a phrase is pasted", () => {
  const messy = `  ${VECTOR.toUpperCase().replace(/ /g, "   ")}  `;
  assert.equal(addressFromMnemonic(messy), VECTOR_ADDRESS);
});

test("a mistyped phrase is refused rather than silently deriving", () => {
  assert.throws(
    () => accountFromMnemonic("abandon abandon not actually a real phrase"),
    /isn't valid/i,
  );
});

test("the signature recovers to the derived address", async () => {
  // Same recovery the backend performs on a personal_sign challenge.
  const phrase = createMnemonic();
  const account = accountFromMnemonic(phrase);
  const message = "settu wants you to sign in with your Ethereum account";

  const signature = await signMessage(account, message);
  assert.equal(
    await recoverMessageAddress({ message, signature }),
    account.address,
  );
});

test("a signature from another phrase recovers to a different address", async () => {
  const mine = accountFromMnemonic(createMnemonic());
  const theirs = accountFromMnemonic(createMnemonic());
  const message = "settu challenge";

  const signature = await signMessage(theirs, message);
  assert.notEqual(
    await recoverMessageAddress({ message, signature }),
    mine.address,
  );
});
