// Solana keys from the same recovery phrase as Stellar — a different
// derivation path, not a second wallet with a second phrase to back up.

import { Keypair, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { mnemonicToSeedSync } from "bip39";
import { derivePath } from "ed25519-hd-key";
import { isValidMnemonic, normalizeMnemonic } from "./mnemonic";

// Phantom's default for the first account. Solflare and others default to
// m/44'/501'/0', so an imported phrase can show a different address there.
const ACCOUNT_PATH = "m/44'/501'/0'/0'";

/** Throws rather than deriving a plausible key from a mistyped phrase. */
export function keypairFromMnemonic(phrase: string): Keypair {
  const normalized = normalizeMnemonic(phrase);
  if (!isValidMnemonic(normalized)) {
    throw new Error("That recovery phrase isn't valid. Check the words again.");
  }
  const seed = mnemonicToSeedSync(normalized).toString("hex");
  return Keypair.fromSeed(derivePath(ACCOUNT_PATH, seed).key);
}

/** The public address only — the secret never leaves the caller's scope. */
export function addressFromMnemonic(phrase: string): string {
  return keypairFromMnemonic(phrase).publicKey.toBase58();
}

/** Base58 ed25519 signature over the raw message, which is what the API verifies. */
export function signMessage(keypair: Keypair, message: string): string {
  const signature = nacl.sign.detached(
    new TextEncoder().encode(message),
    keypair.secretKey,
  );
  return bs58.encode(signature);
}

/** Signs a prepared burn and relays it, so the Settu wallet needs no provider. */
export async function signAndSendTransaction(
  keypair: Keypair,
  transactionBase64: string,
  extraSigners: Keypair[],
): Promise<string> {
  const tx = VersionedTransaction.deserialize(
    Uint8Array.from(Buffer.from(transactionBase64, "base64")),
  );
  tx.sign([...extraSigners, keypair]);

  // Relayed rather than sent direct, so the RPC key stays server-side.
  const res = await fetch("/api/wallet/solana/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transaction: Buffer.from(tx.serialize()).toString("base64"),
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error ?? "Could not submit that transaction");
  }
  return payload.signature as string;
}
