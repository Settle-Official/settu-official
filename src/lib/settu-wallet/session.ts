// An unlocked Settu wallet, held in memory only.
// Never persisted: a reload or the idle timeout means unlocking again.

import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { unsealSecret, type SealedWallet, type UnlockWith } from "./keys";

// Long enough to finish an offramp, short enough that an unattended tab isn't
// left able to sign.
const IDLE_TIMEOUT_MS = 15 * 60_000;

interface Session {
  keypair: Keypair;
  expiresAt: number;
}

let session: Session | null = null;

function live(): Session | null {
  if (session && Date.now() > session.expiresAt) session = null;
  return session;
}

/** Decrypts the secret and holds it until the idle timeout. */
export async function unlockWallet(
  sealed: SealedWallet,
  unlock: UnlockWith,
): Promise<string> {
  const secret = await unsealSecret(sealed, unlock);
  session = {
    keypair: Keypair.fromSecret(secret),
    expiresAt: Date.now() + IDLE_TIMEOUT_MS,
  };
  return session.keypair.publicKey();
}

export function lockWallet(): void {
  session = null;
}

export function unlockedAddress(): string | null {
  return live()?.keypair.publicKey() ?? null;
}

export function isUnlocked(): boolean {
  return live() !== null;
}

/** Signs and extends the idle window, since signing is activity. */
export function signWithSettuWallet(xdr: string): string {
  const current = live();
  if (!current) {
    throw new Error("Your wallet is locked. Unlock it and try again.");
  }
  const tx = TransactionBuilder.fromXDR(xdr, Networks.PUBLIC);
  tx.sign(current.keypair);
  current.expiresAt = Date.now() + IDLE_TIMEOUT_MS;
  return tx.toXDR();
}
