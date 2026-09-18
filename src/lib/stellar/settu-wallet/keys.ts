// The secret is encrypted once under a random data key; that key is wrapped
// per unlock method. The server holds no wrap key, so it cannot decrypt.

import { Keypair } from "@stellar/stellar-sdk";

export type WrapType = "password" | "recovery" | "passkey";

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
}

export interface SealedWallet {
  version: 1;
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
  label?: string,
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
    ...(label ? { label } : {}),
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

// Crockford base32 minus look-alikes, so a code survives being read aloud.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_LEN = 5;

export function generateRecoveryCode(): string {
  const total = RECOVERY_GROUPS * RECOVERY_GROUP_LEN;
  const bytes = randomBytes(total);
  let out = "";
  for (let i = 0; i < total; i++) {
    if (i > 0 && i % RECOVERY_GROUP_LEN === 0) out += "-";
    out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  }
  return out;
}

/** Codes are compared case- and separator-insensitively. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export interface CreatedWallet {
  sealed: SealedWallet;
  publicKey: string;
  recoveryCode: string;
}

/** The secret exists only inside this call; the recovery code is shown once. */
export async function createSealedWallet(
  password: string,
): Promise<CreatedWallet> {
  const keypair = Keypair.random();
  const secret = keypair.secret();
  const recoveryCode = generateRecoveryCode();

  const dek = randomBytes(DEK_BYTES);
  const iv = randomBytes(AES_IV_BYTES);
  const dekKey = await subtle().importKey("raw", dek as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    dekKey,
    new TextEncoder().encode(secret) as BufferSource,
  );

  const wraps = await Promise.all([
    wrapDek(dek, "password", password),
    wrapDek(dek, "recovery", normalizeRecoveryCode(recoveryCode)),
  ]);

  return {
    publicKey: keypair.publicKey(),
    recoveryCode,
    sealed: {
      version: 1,
      publicKey: keypair.publicKey(),
      iv: toB64(iv),
      ciphertext: toB64(new Uint8Array(ciphertext)),
      wraps,
    },
  };
}

export type UnlockWith =
  | { type: "password"; secret: string }
  | { type: "recovery"; secret: string }
  | { type: "passkey"; secret: string };

/** Decrypt the Stellar secret. Throws rather than returning a partial result. */
export async function unsealSecret(
  sealed: SealedWallet,
  unlock: UnlockWith,
): Promise<string> {
  const secret =
    unlock.type === "recovery"
      ? normalizeRecoveryCode(unlock.secret)
      : unlock.secret;
  const dek = await unwrapDek(sealed, unlock.type, secret);

  const dekKey = await subtle().importKey("raw", dek as BufferSource, "AES-GCM", false, [
    "decrypt",
  ]);
  const plaintext = await subtle().decrypt(
    { name: "AES-GCM", iv: fromB64(sealed.iv) as BufferSource },
    dekKey,
    fromB64(sealed.ciphertext) as BufferSource,
  );
  const stellarSecret = new TextDecoder().decode(plaintext);

  // Server-stored, so a tampered publicKey must not redirect signing.
  if (Keypair.fromSecret(stellarSecret).publicKey() !== sealed.publicKey) {
    throw new Error("Wallet data failed its integrity check.");
  }
  return stellarSecret;
}

/** Adds an unlock method, proving an existing one. The secret is untouched. */
export async function addUnlockMethod(
  sealed: SealedWallet,
  existing: UnlockWith,
  addition: UnlockWith & { label?: string },
): Promise<SealedWallet> {
  const currentSecret =
    existing.type === "recovery"
      ? normalizeRecoveryCode(existing.secret)
      : existing.secret;
  const dek = await unwrapDek(sealed, existing.type, currentSecret);

  const nextSecret =
    addition.type === "recovery"
      ? normalizeRecoveryCode(addition.secret)
      : addition.secret;
  const wrap = await wrapDek(dek, addition.type, nextSecret, addition.label);

  return { ...sealed, wraps: [...sealed.wraps, wrap] };
}
