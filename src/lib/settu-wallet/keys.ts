// The secret is encrypted once under a random data key; that key is wrapped
// per unlock method. The server holds no wrap key, so it cannot decrypt.

import { Keypair } from "@stellar/stellar-sdk";
import { createMnemonic, isValidMnemonic, keypairFromMnemonic } from "./mnemonic";

// The mnemonic is not a wrap: holding it yields the key directly, with nothing
// to unwrap and no dependence on the stored blob.
export type WrapType = "password" | "passkey";

/** One way to unwrap the DEK. Versioned so the KDF can change later. */
export interface DekWrap {
  type: WrapType;
  version: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  wrappedDek: string;
  label?: string;
  /** Which passkey to prompt for. Public by design, not a secret. */
  credentialId?: string;
}

export interface SealedWallet {
  // v1 sealed the Stellar secret. v2 seals the mnemonic, so every chain can be
  // derived from one envelope; v1 blobs keep working untouched.
  version: 1 | 2;
  publicKey: string;
  iv: string;
  ciphertext: string;
  wraps: DekWrap[];
}

// OWASP's floor for PBKDF2-HMAC-SHA256. WebCrypto has no Argon2id; `version`
// lets the KDF change later without invalidating stored blobs.
const PASSWORD_ITERATIONS = 600_000;
// Already 160 bits of randomness, so stretching it would only cost the user.
const HIGH_ENTROPY_ITERATIONS = 10_000;

const AES_IV_BYTES = 12;
const SALT_BYTES = 16;
const DEK_BYTES = 32;

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto unavailable");
  return c.subtle;
};

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function toB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromB64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Stretch a human secret into an AES key used only to wrap the DEK. */
async function deriveKek(
  secret: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await subtle().importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle().deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function iterationsFor(type: WrapType): number {
  return type === "password" ? PASSWORD_ITERATIONS : HIGH_ENTROPY_ITERATIONS;
}

/** Wrap an existing DEK under one more unlock secret. */
async function wrapDek(
  dek: Uint8Array,
  type: WrapType,
  secret: string,
  meta: { label?: string; credentialId?: string } = {},
): Promise<DekWrap> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(AES_IV_BYTES);
  const iterations = iterationsFor(type);
  const kek = await deriveKek(secret, salt, iterations);
  const wrapped = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    kek,
    dek as BufferSource,
  );
  return {
    type,
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: toB64(salt),
    iv: toB64(iv),
    wrappedDek: toB64(new Uint8Array(wrapped)),
    ...(meta.label ? { label: meta.label } : {}),
    ...(meta.credentialId ? { credentialId: meta.credentialId } : {}),
  };
}

/** Recover the DEK from whichever wraps this secret can open. */
async function unwrapDek(
  sealed: SealedWallet,
  type: WrapType,
  secret: string,
): Promise<Uint8Array> {
  for (const wrap of sealed.wraps.filter((w) => w.type === type)) {
    try {
      const kek = await deriveKek(secret, fromB64(wrap.salt), wrap.iterations);
      const dek = await subtle().decrypt(
        { name: "AES-GCM", iv: fromB64(wrap.iv) as BufferSource },
        kek,
        fromB64(wrap.wrappedDek) as BufferSource,
      );
      return new Uint8Array(dek);
    } catch {
      // Wrong secret for this wrap — a later one of the same type may open.
    }
  }
  throw new Error("Could not unlock the wallet with that secret.");
}

export interface CreatedWallet {
  sealed: SealedWallet;
  publicKey: string;
  /** Shown once. The only way back in without the password, and the only way out. */
  mnemonic: string;
}

/** Builds a fresh v2 envelope around a mnemonic. */
async function sealSecret(
  mnemonic: string,
  password: string,
): Promise<SealedWallet> {
  const keypair = keypairFromMnemonic(mnemonic);
  const dek = randomBytes(DEK_BYTES);
  const iv = randomBytes(AES_IV_BYTES);
  const dekKey = await subtle().importKey(
    "raw",
    dek as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    dekKey,
    new TextEncoder().encode(mnemonic) as BufferSource,
  );

  return {
    version: 2,
    publicKey: keypair.publicKey(),
    iv: toB64(iv),
    ciphertext: toB64(new Uint8Array(ciphertext)),
    wraps: [await wrapDek(dek, "password", password)],
  };
}

/** The secret exists only inside this call; the phrase is shown once. */
export async function createSealedWallet(
  password: string,
): Promise<CreatedWallet> {
  const mnemonic = createMnemonic();
  return {
    publicKey: keypairFromMnemonic(mnemonic).publicKey(),
    mnemonic,
    sealed: await sealSecret(mnemonic, password),
  };
}

export type UnlockWith =
  | { type: "password"; secret: string }
  | { type: "passkey"; secret: string }
  | { type: "mnemonic"; secret: string };

/** The decrypted payload: a mnemonic in v2, a bare Stellar secret in v1. */
async function unsealPayload(
  sealed: SealedWallet,
  unlock: UnlockWith,
): Promise<string> {
  if (unlock.type === "mnemonic") {
    if (keypairFromMnemonic(unlock.secret).publicKey() !== sealed.publicKey) {
      throw new Error("That phrase belongs to a different wallet.");
    }
    return unlock.secret;
  }

  const dek = await unwrapDek(sealed, unlock.type, unlock.secret);
  const dekKey = await subtle().importKey(
    "raw",
    dek as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await subtle().decrypt(
    { name: "AES-GCM", iv: fromB64(sealed.iv) as BufferSource },
    dekKey,
    fromB64(sealed.ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * The recovery phrase, for deriving keys on chains other than Stellar.
 * v1 envelopes hold only a Stellar secret, so they have none to give.
 */
export async function unsealMnemonic(
  sealed: SealedWallet,
  unlock: UnlockWith,
): Promise<string> {
  const payload = await unsealPayload(sealed, unlock);
  if (!isValidMnemonic(payload)) {
    throw new Error(
      "This wallet predates multi-chain support. Recover it with your phrase to enable other chains.",
    );
  }
  return payload;
}

/** Both halves from one unwrap; v1 envelopes carry no phrase. */
export async function unsealWallet(
  sealed: SealedWallet,
  unlock: UnlockWith,
): Promise<{ secret: string; mnemonic: string | null }> {
  const payload = await unsealPayload(sealed, unlock);
  const isPhrase = isValidMnemonic(payload);
  const secret = isPhrase ? keypairFromMnemonic(payload).secret() : payload;

  if (Keypair.fromSecret(secret).publicKey() !== sealed.publicKey) {
    throw new Error("Wallet data failed its integrity check.");
  }
  return { secret, mnemonic: isPhrase ? payload : null };
}

/** Decrypt the Stellar secret. Throws rather than returning a partial result. */
export async function unsealSecret(
  sealed: SealedWallet,
  unlock: UnlockWith,
): Promise<string> {
  const payload = await unsealPayload(sealed, unlock);
  const stellarSecret = isValidMnemonic(payload)
    ? keypairFromMnemonic(payload).secret()
    : payload;

  // Server-stored, so a tampered publicKey must not redirect signing.
  if (Keypair.fromSecret(stellarSecret).publicKey() !== sealed.publicKey) {
    throw new Error("Wallet data failed its integrity check.");
  }
  return stellarSecret;
}

/** Adds an unlock method, proving an existing one. The secret is untouched. */
export async function addUnlockMethod(
  sealed: SealedWallet,
  existing: { type: WrapType; secret: string },
  addition: {
    type: WrapType;
    secret: string;
    label?: string;
    credentialId?: string;
  },
): Promise<SealedWallet> {
  const dek = await unwrapDek(sealed, existing.type, existing.secret);
  const wrap = await wrapDek(dek, addition.type, addition.secret, {
    label: addition.label,
    credentialId: addition.credentialId,
  });
  return { ...sealed, wraps: [...sealed.wraps, wrap] };
}

// Forgot-password recovery. A phrase yields the key but not the DEK, so the
// envelope is rebuilt rather than rewrapped; the Stellar key is unchanged.
export async function resealFromMnemonic(
  phrase: string,
  password: string,
): Promise<SealedWallet> {
  return sealSecret(phrase, password);
}
