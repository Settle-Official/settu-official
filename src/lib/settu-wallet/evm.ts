// EVM keys from the same recovery phrase as Stellar and Solana. secp256k1
// rather than ed25519, so derivation comes from viem rather than ed25519-hd-key.

import { mnemonicToAccount } from "viem/accounts";
import type { HDAccount } from "viem";
import { isValidMnemonic, normalizeMnemonic } from "./mnemonic";

// viem's default is BIP-44's m/44'/60'/0'/0/0 — what MetaMask and every other
// EVM wallet shows as the first account.
export function accountFromMnemonic(phrase: string): HDAccount {
  const normalized = normalizeMnemonic(phrase);
  if (!isValidMnemonic(normalized)) {
    throw new Error("That recovery phrase isn't valid. Check the words again.");
  }
  return mnemonicToAccount(normalized);
}

/** Checksummed address; the same one MetaMask derives from this phrase. */
export function addressFromMnemonic(phrase: string): `0x${string}` {
  return accountFromMnemonic(phrase).address;
}

/** personal_sign over the challenge, which is what the API recovers against. */
export function signMessage(
  account: HDAccount,
  message: string,
): Promise<`0x${string}`> {
  return account.signMessage({ message });
}
