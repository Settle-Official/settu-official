// SEP-0005 key derivation. The phrase is the key material itself, so it works
// in Freighter or LOBSTR and keeps working if Settu does not exist.

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "bip39";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@stellar/stellar-sdk";

// 256 bits gives 24 words. SEP-0005 allows 12, but this is the phrase standing
// between a user and their funds forever, so take the stronger one.
const ENTROPY_BITS = 256;

// SEP-0005's path for a wallet's first Stellar account.
const ACCOUNT_PATH = "m/44'/148'/0'";

export function createMnemonic(): string {
  return generateMnemonic(ENTROPY_BITS);
}

/** Case and spacing vary wildly when typed or pasted back. */
export function normalizeMnemonic(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isValidMnemonic(phrase: string): boolean {
  return validateMnemonic(normalizeMnemonic(phrase));
}

/** Throws rather than deriving a valid-looking key from a mistyped phrase. */
export function keypairFromMnemonic(phrase: string): Keypair {
  const normalized = normalizeMnemonic(phrase);
  if (!validateMnemonic(normalized)) {
    throw new Error("That recovery phrase isn't valid. Check the words again.");
  }
  const seed = mnemonicToSeedSync(normalized).toString("hex");
  return Keypair.fromRawEd25519Seed(
    Buffer.from(derivePath(ACCOUNT_PATH, seed).key),
  );
}
