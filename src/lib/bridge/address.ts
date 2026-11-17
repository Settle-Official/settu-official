/**
 * Destination address validation for the user bridge (spec §8).
 *
 * Synchronous and pure: format and static rules only. A CCTP mint recipient is
 * fixed at burn time, so a wrong destination loses funds for good — when in
 * doubt this rejects. Live checks (Stellar trustline, Solana ATA) are Task 11.
 * Shared by the UI, the quote endpoint and the server before it signs.
 */

import { PublicKey } from "@solana/web3.js";
import { StrKey } from "@stellar/stellar-sdk";
import { getAddress } from "viem";
import { CCTP_CONFIG } from "../cctp/constants";
import { EVM_CCTP_TOKEN_MESSENGER_V2 } from "../cctp/evm-chains";
import { SOLANA_CONFIG } from "../solana/config";
import {
  BRIDGE_CHAINS,
  type BridgeChainKey,
  type ChainFamily,
} from "./chains";

export type AddressErrorCode =
  | "empty"
  | "wrong_family"
  | "bad_format"
  | "bad_checksum"
  | "secret_key"
  | "muxed"
  | "contract"
  | "forbidden"
  /** Produced by the live checks in Task 11, never by this module. */
  | "token_account";

export type AddressCheck =
  | { ok: true; address: string }
  | { ok: false; code: AddressErrorCode; message: string };

/**
 * Settu's own bridge contracts and relayer addresses, per chain. Empty until
 * Task 9 fills it after deployment. Consulted by every validation, in
 * addition to the static rules below.
 */
export const BRIDGE_FORBIDDEN_ADDRESSES: Record<
  BridgeChainKey,
  readonly string[]
> = {
  stellar: [],
  ethereum: [],
  base: [],
  arbitrum: [],
  optimism: [],
  avalanche: [],
  polygon: [],
  solana: [],
};

const EVM_ZERO = "0x0000000000000000000000000000000000000000";

// MessageTransmitterV2 is the same on all six EVM chains on mainnet
// (0x81D4…, Circle's raw contract-addresses docs, 2026-11-17) and on testnet
// (0xE737…). CCTP_CONFIG's Base value follows CCTP_NETWORK; both networks'
// addresses are listed so a mainnet build also refuses the testnet ones
// (rejecting extra addresses is harmless).
const EVM_CCTP_CONTRACTS: readonly string[] = [
  EVM_CCTP_TOKEN_MESSENGER_V2,
  CCTP_CONFIG.baseTokenMessengerV2,
  CCTP_CONFIG.baseMessageTransmitterV2,
  "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", // MessageTransmitterV2, mainnet
  "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275", // MessageTransmitterV2, testnet
  "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", // TokenMessengerV2, testnet
];

function staticForbidden(chain: BridgeChainKey): string[] {
  const usdc = BRIDGE_CHAINS[chain].usdc;
  switch (BRIDGE_CHAINS[chain].family) {
    case "evm":
      return [EVM_ZERO, usdc, ...EVM_CCTP_CONTRACTS];
    case "stellar":
      return [
        usdc,
        CCTP_CONFIG.stellarTokenMessengerMinter,
        CCTP_CONFIG.stellarMessageTransmitter,
        CCTP_CONFIG.stellarCctpForwarder,
      ];
    case "solana":
      return [
        usdc,
        SOLANA_CONFIG.messageTransmitterV2,
        SOLANA_CONFIG.tokenMessengerMinterV2,
        "11111111111111111111111111111111", // System Program
      ];
  }
}

function isForbidden(chain: BridgeChainKey, input: string): boolean {
  const evm = BRIDGE_CHAINS[chain].family === "evm";
  const norm = (s: string) => (evm ? s.toLowerCase() : s);
  const target = norm(input);
  return [...staticForbidden(chain), ...BRIDGE_FORBIDDEN_ADDRESSES[chain]].some(
    (a) => norm(a) === target,
  );
}

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const STRKEY_BODY = "[A-Z2-7]";
const G_SHAPE = new RegExp(`^G${STRKEY_BODY}{55}$`);
const S_SHAPE = new RegExp(`^S${STRKEY_BODY}{55}$`);
const C_SHAPE = new RegExp(`^C${STRKEY_BODY}{55}$`);
const M_SHAPE = new RegExp(`^M${STRKEY_BODY}{68}$`);

function isSolanaAddress(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  try {
    new PublicKey(s); // throws unless base58 decoding to exactly 32 bytes
    return true;
  } catch {
    return false;
  }
}

const FAMILY_NAME: Record<ChainFamily, string> = {
  evm: "an Ethereum-style address",
  stellar: "a Stellar address",
  solana: "a Solana address",
};

function needs(chain: BridgeChainKey): string {
  const { family, label } = BRIDGE_CHAINS[chain];
  if (family === "evm") return `${label} needs an address starting with 0x.`;
  if (family === "stellar")
    return `${label} needs an address starting with G.`;
  return `${label} needs a Solana wallet address.`;
}

function bad(code: AddressErrorCode, message: string): AddressCheck {
  return { ok: false, code, message };
}

/** The family an input clearly belongs to, or null if it isn't clearly any. */
function detectFamily(s: string): ChainFamily | null {
  if (EVM_RE.test(s)) return "evm";
  if (G_SHAPE.test(s) || C_SHAPE.test(s) || M_SHAPE.test(s)) return "stellar";
  if (isSolanaAddress(s)) return "solana";
  return null;
}

export function validateDestinationAddress(
  chain: BridgeChainKey,
  input: string,
): AddressCheck {
  const value = input.trim();
  if (!value) return bad("empty", "Enter a destination address.");

  // A pasted secret key is the worst case: say so whatever the chain.
  if (S_SHAPE.test(value)) {
    return bad("secret_key", "That's a secret key — never paste it anywhere");
  }

  if (isForbidden(chain, value)) {
    return bad(
      "forbidden",
      "That's a contract address, not a wallet. Funds sent there would be lost.",
    );
  }

  const { family } = BRIDGE_CHAINS[chain];

  const detected = detectFamily(value);
  if (detected && detected !== family) {
    return bad("wrong_family", `That's ${FAMILY_NAME[detected]}. ${needs(chain)}`);
  }

  switch (family) {
    case "evm": {
      if (!EVM_RE.test(value)) {
        return bad(
          "bad_format",
          "Enter a 42-character address starting with 0x.",
        );
      }
      const hex = value.slice(2);
      const checksum = getAddress(value);
      const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
      if (mixed && checksum !== value) {
        return bad(
          "bad_checksum",
          "This address has a typo — the capitalisation doesn't match its checksum.",
        );
      }
      return { ok: true, address: checksum };
    }
    case "solana": {
      if (!isSolanaAddress(value)) {
        return bad(
          "bad_format",
          "That doesn't look like a Solana wallet address.",
        );
      }
      return { ok: true, address: value };
    }
    case "stellar": {
      if (M_SHAPE.test(value)) {
        return bad(
          "muxed",
          "Muxed (M…) addresses aren't supported. Use the account's G… address.",
        );
      }
      if (C_SHAPE.test(value)) {
        return bad(
          "contract",
          "Contract (C…) addresses aren't supported. Use a G… wallet address.",
        );
      }
      if (!G_SHAPE.test(value)) {
        return bad(
          "bad_format",
          "Enter a 56-character Stellar address starting with G.",
        );
      }
      if (!StrKey.isValidEd25519PublicKey(value)) {
        return bad(
          "bad_checksum",
          "This address has a typo — it fails the Stellar checksum.",
        );
      }
      return { ok: true, address: value };
    }
  }
}
