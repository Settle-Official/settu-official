/**
 * Settu bridge quote: encoding and signing.
 *
 * The server signs a quote; the Settu bridge contract on the source chain
 * verifies it and takes exactly `totalFee`. The server and the three
 * contracts (Solidity, Soroban, Anchor) must agree byte-for-byte, which
 * `contracts/test-vectors/quotes.json` (see quote.test.ts) pins down.
 *
 * EVM chains: EIP-712 typed data, secp256k1 (see EVM_QUOTE_TYPE_STRING).
 * Stellar + Solana: ed25519 over the fixed big-endian layout produced by
 * `encodeQuoteBytes`.
 *
 * Never log key material from this module.
 */

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import {
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { StrKey } from "@stellar/stellar-sdk";
import { PublicKey } from "@solana/web3.js";

export interface BridgeQuote {
  version: 1;
  sourceDomain: number;
  destDomain: number;
  /** Source-chain address in its family's native form (0x…, G…, base58). */
  user: string;
  amount: bigint;
  totalFee: bigint;
  /** bytes32. Stellar dest: the forwarder; Solana dest: recipient's USDC ATA. */
  mintRecipient: `0x${string}`;
  /** `0x` unless the destination is Stellar (then buildForwarderHookData(G…)). */
  hookData: `0x${string}`;
  maxFee: bigint;
  minFinality: 1000 | 2000;
  /** Unix seconds. */
  deadline: number;
  /** 32 random bytes. */
  nonce: `0x${string}`;
}

// ---------------------------------------------------------------- EVM

export const EVM_QUOTE_DOMAIN_NAME = "SettuBridge";
export const EVM_QUOTE_DOMAIN_VERSION = "1";

/** Field order and types are part of the protocol; Solidity must match. */
export const EVM_QUOTE_TYPES = {
  Quote: [
    { name: "version", type: "uint8" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destDomain", type: "uint32" },
    { name: "user", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "totalFee", type: "uint256" },
    { name: "mintRecipient", type: "bytes32" },
    { name: "hookData", type: "bytes" },
    { name: "maxFee", type: "uint256" },
    { name: "minFinality", type: "uint32" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** keccak256 of this string is the Solidity QUOTE_TYPEHASH. */
export const EVM_QUOTE_TYPE_STRING =
  "Quote(" +
  EVM_QUOTE_TYPES.Quote.map((f) => `${f.type} ${f.name}`).join(",") +
  ")";

function evmTypedData(quote: BridgeQuote, chainId: number, verifyingContract: Address) {
  checkBytes32(quote.mintRecipient, "mintRecipient");
  checkBytes32(quote.nonce, "nonce");
  hexToBytes(quote.hookData, "hookData");
  return {
    domain: {
      name: EVM_QUOTE_DOMAIN_NAME,
      version: EVM_QUOTE_DOMAIN_VERSION,
      chainId,
      verifyingContract,
    },
    types: EVM_QUOTE_TYPES,
    primaryType: "Quote" as const,
    message: {
      version: quote.version,
      sourceDomain: quote.sourceDomain,
      destDomain: quote.destDomain,
      user: quote.user as Address,
      amount: quote.amount,
      totalFee: quote.totalFee,
      mintRecipient: quote.mintRecipient,
      hookData: quote.hookData,
      maxFee: quote.maxFee,
      minFinality: quote.minFinality,
      deadline: BigInt(quote.deadline),
      nonce: quote.nonce,
    },
  };
}

/** The EIP-712 digest the contract computes and ecrecovers against. */
export function hashEvmQuote(quote: BridgeQuote, chainId: number, verifyingContract: Address): Hex {
  return hashTypedData(evmTypedData(quote, chainId, verifyingContract));
}

export async function signEvmQuote(
  quote: BridgeQuote,
  chainId: number,
  verifyingContract: Address,
  privateKey: Hex,
): Promise<Hex> {
  return privateKeyToAccount(privateKey).signTypedData(
    evmTypedData(quote, chainId, verifyingContract),
  );
}

export async function recoverEvmQuoteSigner(
  quote: BridgeQuote,
  chainId: number,
  verifyingContract: Address,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({
    ...evmTypedData(quote, chainId, verifyingContract),
    signature,
  });
}

// ---------------------------------------------------------------- ed25519

export const ED25519_QUOTE_PREFIX = "SETTU_BRIDGE_V1";

/**
 * Layout (all integers big-endian):
 *   "SETTU_BRIDGE_V1" (15 ASCII bytes, no length prefix/terminator)
 *   contractId 32 | sourceDomain u32 | destDomain u32 | user 32
 *   amount u64 | totalFee u64 | mintRecipient 32 | maxFee u64
 *   minFinality u32 | deadline u64 | nonce 32 | hookData length u32 | hookData
 */
export const ED25519_QUOTE_FIXED_LENGTH =
  15 + 32 + 4 + 4 + 32 + 8 + 8 + 32 + 8 + 4 + 8 + 32 + 4;

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const U32_MAX = 0xffffffff;

export type Ed25519Family = "stellar" | "solana";

export function encodeQuoteBytes(
  quote: BridgeQuote,
  family: Ed25519Family,
  contractId: string,
): Uint8Array {
  if (quote.version !== 1) throw new Error(`Unsupported quote version: ${quote.version}`);
  const contract = decodeContractId(family, contractId);
  const user = decodeUser(family, quote.user);
  const mintRecipient = checkBytes32(quote.mintRecipient, "mintRecipient");
  const nonce = checkBytes32(quote.nonce, "nonce");
  const hookData = hexToBytes(quote.hookData, "hookData");
  if (!Number.isSafeInteger(quote.deadline) || quote.deadline < 0) {
    throw new Error(`deadline must be a non-negative integer: ${quote.deadline}`);
  }

  const out = Buffer.alloc(ED25519_QUOTE_FIXED_LENGTH + hookData.length);
  let o = 0;
  o += out.write(ED25519_QUOTE_PREFIX, o, "ascii");
  o += Buffer.from(contract).copy(out, o);
  o = out.writeUInt32BE(u32(quote.sourceDomain, "sourceDomain"), o);
  o = out.writeUInt32BE(u32(quote.destDomain, "destDomain"), o);
  o += Buffer.from(user).copy(out, o);
  o = out.writeBigUInt64BE(u64(quote.amount, "amount"), o);
  o = out.writeBigUInt64BE(u64(quote.totalFee, "totalFee"), o);
  o += Buffer.from(mintRecipient).copy(out, o);
  o = out.writeBigUInt64BE(u64(quote.maxFee, "maxFee"), o);
  o = out.writeUInt32BE(u32(quote.minFinality, "minFinality"), o);
  o = out.writeBigUInt64BE(u64(BigInt(quote.deadline), "deadline"), o);
  o += Buffer.from(nonce).copy(out, o);
  o = out.writeUInt32BE(u32(hookData.length, "hookData length"), o);
  o += Buffer.from(hookData).copy(out, o);
  if (o !== out.length) throw new Error("internal: quote encoding length mismatch");
  return new Uint8Array(out);
}

// PKCS#8 / SPKI DER prefixes for a raw ed25519 key (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
}

export function ed25519PublicKeyFromSeed(seed: Uint8Array): Uint8Array {
  const der = createPublicKey(privateKeyFromSeed(seed)).export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(der.length - 32));
}

/** `secret` is the raw 32-byte ed25519 seed. Returns the 64-byte signature. */
export function signEd25519Quote(bytes: Uint8Array, secret: Uint8Array): Uint8Array {
  return new Uint8Array(sign(null, bytes, privateKeyFromSeed(secret)));
}

export function verifyEd25519Quote(
  bytes: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKey)]),
    format: "der",
    type: "spki",
  });
  return verify(null, bytes, key, signature);
}

// ---------------------------------------------------------------- env keys

/** BRIDGE_QUOTE_SIGNER_EVM_KEY: 32-byte secp256k1 private key hex, `0x` optional. */
export function loadEvmQuoteSignerKey(): Hex {
  const raw = process.env.BRIDGE_QUOTE_SIGNER_EVM_KEY?.trim();
  if (!raw) throw new Error("BRIDGE_QUOTE_SIGNER_EVM_KEY is not set");
  const hex = raw.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("BRIDGE_QUOTE_SIGNER_EVM_KEY must be 32-byte hex");
  }
  return `0x${hex.toLowerCase()}`;
}

/**
 * BRIDGE_QUOTE_SIGNER_ED25519_SECRET accepts either:
 *   - the 32-byte ed25519 seed as 64 hex chars (`0x` optional), or
 *   - a Stellar secret strkey (S…), which encodes the same seed.
 * Returns the raw 32-byte seed.
 */
export function loadEd25519QuoteSignerSecret(): Uint8Array {
  const raw = process.env.BRIDGE_QUOTE_SIGNER_ED25519_SECRET?.trim();
  if (!raw) throw new Error("BRIDGE_QUOTE_SIGNER_ED25519_SECRET is not set");
  if (raw.startsWith("S") && StrKey.isValidEd25519SecretSeed(raw)) {
    return new Uint8Array(StrKey.decodeEd25519SecretSeed(raw));
  }
  const hex = raw.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return new Uint8Array(Buffer.from(hex, "hex"));
  throw new Error(
    "BRIDGE_QUOTE_SIGNER_ED25519_SECRET must be a 32-byte hex seed or a Stellar S... secret",
  );
}

// ---------------------------------------------------------------- helpers

function hexToBytes(value: string, field: string): Uint8Array {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${field} must be even-length 0x-prefixed hex`);
  }
  return new Uint8Array(Buffer.from(value.slice(2), "hex"));
}

function checkBytes32(value: string, field: string): Uint8Array {
  const b = hexToBytes(value, field);
  if (b.length !== 32) throw new Error(`${field} must be 32 bytes, got ${b.length}`);
  return b;
}

function u32(n: number, field: string): number {
  if (!Number.isInteger(n) || n < 0 || n > U32_MAX) throw new Error(`${field} out of u32 range: ${n}`);
  return n;
}

function u64(n: bigint, field: string): bigint {
  if (typeof n !== "bigint" || n < BigInt(0) || n > U64_MAX) {
    throw new Error(`${field} out of u64 range: ${n}`);
  }
  return n;
}

function decodeUser(family: Ed25519Family, user: string): Uint8Array {
  if (family === "stellar") {
    if (!StrKey.isValidEd25519PublicKey(user)) throw new Error(`Invalid Stellar user: ${user}`);
    return new Uint8Array(StrKey.decodeEd25519PublicKey(user));
  }
  return solanaPubkeyBytes(user, "user");
}

function decodeContractId(family: Ed25519Family, contractId: string): Uint8Array {
  if (family === "stellar") {
    if (!StrKey.isValidContract(contractId)) {
      throw new Error(`Invalid Stellar contract id: ${contractId}`);
    }
    return new Uint8Array(StrKey.decodeContract(contractId));
  }
  return solanaPubkeyBytes(contractId, "program id");
}

function solanaPubkeyBytes(value: string, field: string): Uint8Array {
  // Base58 only, so strkeys / hex can't be mis-decoded as pubkeys.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new Error(`Invalid Solana ${field}: ${value}`);
  let pk: PublicKey;
  try {
    pk = new PublicKey(value);
  } catch {
    throw new Error(`Invalid Solana ${field}: ${value}`);
  }
  const bytes = pk.toBytes();
  if (bytes.length !== 32) throw new Error(`Invalid Solana ${field}: ${value}`);
  return bytes;
}
