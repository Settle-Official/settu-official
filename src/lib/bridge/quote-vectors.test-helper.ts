/**
 * Golden-vector generator for contracts/test-vectors/quotes.json.
 * Used by quote.test.ts (which documents how to regenerate the file).
 *
 * EVERY KEY IN THIS FILE IS TEST-ONLY AND PUBLICLY KNOWN. Never fund or
 * configure them anywhere real.
 */
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { StrKey } from "@stellar/stellar-sdk";
import { PublicKey } from "@solana/web3.js";
import {
  type BridgeQuote,
  ED25519_QUOTE_FIXED_LENGTH,
  EVM_QUOTE_DOMAIN_NAME,
  EVM_QUOTE_DOMAIN_VERSION,
  EVM_QUOTE_TYPE_STRING,
  ED25519_QUOTE_PREFIX,
  encodeQuoteBytes,
  ed25519PublicKeyFromSeed,
  hashEvmQuote,
  signEd25519Quote,
  signEvmQuote,
} from "./quote";
import { buildForwarderHookData } from "../cctp/address-encoding";

export const QUOTE_VECTORS_PATH = "contracts/test-vectors/quotes.json";

/** TEST-ONLY: Foundry/Anvil default account 0 (0xf39F…2266). */
export const TEST_ONLY_EVM_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/** TEST-ONLY: RFC 8032 §7.1 TEST 1 secret key (seed). */
export const TEST_ONLY_ED25519_SEED = new Uint8Array(
  Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"),
);

const EVM_CHAIN_ID = 84532; // Base Sepolia
const EVM_VERIFYING_CONTRACT = "0x000000000000000000000000000000000000bEEF" as const;
const STELLAR_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 0x11));
const SOLANA_PROGRAM_ID = new PublicKey(Buffer.alloc(32, 0x22)).toBase58();

const STELLAR_USER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x33));
const SOLANA_USER = new PublicKey(Buffer.alloc(32, 0x44)).toBase58();
const EVM_USER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // Anvil account 1
/** Forward recipient G… for hookData (a Stellar destination's real recipient). */
const FORWARD_RECIPIENT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 0x55));

/** 0x0102…20: sequential bytes catch byte-order mistakes. */
const NONCE = `0x${Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(2, "0")).join("")}` as const;
const DEADLINE = 1_800_000_000;

type Json = Record<string, unknown>;

function quoteJson(q: BridgeQuote): Json {
  return {
    version: q.version,
    sourceDomain: q.sourceDomain,
    destDomain: q.destDomain,
    user: q.user,
    amount: q.amount.toString(),
    settuFee: q.settuFee.toString(),
    networkFee: q.networkFee.toString(),
    nativeFee: q.nativeFee.toString(),
    mintRecipient: q.mintRecipient,
    hookData: q.hookData,
    maxFee: q.maxFee.toString(),
    minFinality: q.minFinality,
    deadline: q.deadline.toString(),
    nonce: q.nonce,
  };
}

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;

export interface QuoteVectors {
  cases: Array<{ name: string; quote: Json } & Json>;
}

export async function generateQuoteVectors(): Promise<QuoteVectors & Json> {
  // EVM: Base -> Stellar (non-empty hookData exercises keccak(bytes)).
  const evmQuote: BridgeQuote = {
    version: 1,
    sourceDomain: 6,
    destDomain: 27,
    user: EVM_USER,
    amount: BigInt(100_000_000),
    settuFee: BigInt(500_000),
    networkFee: BigInt(0),
    nativeFee: BigInt("150000000000000"), // 0.00015 ETH in wei
    mintRecipient: `0x${"ab".repeat(32)}`,
    hookData: buildForwarderHookData(FORWARD_RECIPIENT),
    maxFee: BigInt(12_853),
    minFinality: 1000,
    deadline: DEADLINE,
    nonce: NONCE,
  };
  const evmSig = await signEvmQuote(evmQuote, EVM_CHAIN_ID, EVM_VERIFYING_CONTRACT, TEST_ONLY_EVM_PRIVATE_KEY);

  // Stellar source with non-empty hookData: covers the hookData-length path
  // of the ed25519 layout (encoding coverage, not a real route).
  const stellarQuote: BridgeQuote = {
    version: 1,
    sourceDomain: 27,
    destDomain: 6,
    user: STELLAR_USER,
    amount: BigInt(250_000_000),
    settuFee: BigInt(1_250_000),
    networkFee: BigInt(630_000),
    nativeFee: BigInt(0),
    mintRecipient: `0x${"00".repeat(12)}${"70997970c51812dc3a010c7d01b50e0d17dc79c8"}`,
    hookData: buildForwarderHookData(FORWARD_RECIPIENT),
    maxFee: BigInt(0),
    minFinality: 2000,
    deadline: DEADLINE,
    nonce: NONCE,
  };

  // Solana -> Base, empty hookData.
  const solanaQuote: BridgeQuote = {
    version: 1,
    sourceDomain: 5,
    destDomain: 6,
    user: SOLANA_USER,
    amount: BigInt(5_000_000),
    settuFee: BigInt(25_000),
    networkFee: BigInt(0),
    nativeFee: BigInt(2_039_280), // lamports
    mintRecipient: `0x${"00".repeat(12)}${"70997970c51812dc3a010c7d01b50e0d17dc79c8"}`,
    hookData: "0x",
    maxFee: BigInt(650),
    minFinality: 1000,
    deadline: DEADLINE,
    nonce: NONCE,
  };

  const pub = ed25519PublicKeyFromSeed(TEST_ONLY_ED25519_SEED);
  const ed = (q: BridgeQuote, family: "stellar" | "solana", contractId: string) => {
    const bytes = encodeQuoteBytes(q, family, contractId);
    return {
      contractId,
      // Raw 32-byte forms as they appear in `encoded` (for contract tests).
      contractIdHex: hex(bytes.subarray(15, 47)),
      userHex: hex(bytes.subarray(55, 87)),
      quote: quoteJson(q),
      encoded: hex(bytes),
      signature: hex(signEd25519Quote(bytes, TEST_ONLY_ED25519_SEED)),
      signer: hex(pub),
    };
  };

  return {
    _comment:
      "GENERATED by src/lib/bridge/quote-vectors.test-helper.ts — do not edit by hand. " +
      "All keys are TEST-ONLY and publicly known. Regenerate: see header of src/lib/bridge/quote.test.ts.",
    testOnlyKeys: {
      evmPrivateKey: TEST_ONLY_EVM_PRIVATE_KEY,
      ed25519Seed: hex(TEST_ONLY_ED25519_SEED),
    },
    evm: {
      typeString: EVM_QUOTE_TYPE_STRING,
      typeHash: keccak256(toHex(EVM_QUOTE_TYPE_STRING)),
      domain: { name: EVM_QUOTE_DOMAIN_NAME, version: EVM_QUOTE_DOMAIN_VERSION },
    },
    ed25519: {
      prefix: ED25519_QUOTE_PREFIX,
      fixedLength: ED25519_QUOTE_FIXED_LENGTH,
      layout:
        "prefix(15 ascii) | contractId 32 | sourceDomain u32 | destDomain u32 | user 32 | amount u64 | settuFee u64 | networkFee u64 | nativeFee u64 | mintRecipient 32 | maxFee u64 | minFinality u32 | deadline u64 | nonce 32 | hookDataLen u32 | hookData (big-endian)",
    },
    cases: [
      {
        name: "evm",
        chainId: EVM_CHAIN_ID,
        verifyingContract: EVM_VERIFYING_CONTRACT,
        quote: quoteJson(evmQuote),
        digest: hashEvmQuote(evmQuote, EVM_CHAIN_ID, EVM_VERIFYING_CONTRACT),
        signature: evmSig,
        signer: privateKeyToAccount(TEST_ONLY_EVM_PRIVATE_KEY).address,
      },
      { name: "stellar", ...ed(stellarQuote, "stellar", STELLAR_CONTRACT_ID) },
      { name: "solana", ...ed(solanaQuote, "solana", SOLANA_PROGRAM_ID) },
    ],
  };
}

export function serializeQuoteVectors(v: unknown): string {
  return JSON.stringify(v, null, 2) + "\n";
}
