/**
 * Deployed Settu bridge contract and fee wallet per chain, from env:
 *
 *   BRIDGE_CONTRACT_<CHAIN>  EVM: 0x address | Stellar: C… contract id | Solana: program id (base58)
 *   FEE_WALLET_<CHAIN>       EVM: 0x address | Stellar: G… account     | Solana: wallet (base58)
 *
 * CHAIN is the BridgeChainKey upper-cased (BRIDGE_CONTRACT_BASE, …). Read on
 * every call (no caching) and validated against the chain's family, so a
 * missing or wrong-family value throws instead of producing a quote signed
 * for the wrong verifier.
 */

import { PublicKey } from "@solana/web3.js";
import { StrKey } from "@stellar/stellar-sdk";
import { getAddress } from "viem";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";

type Kind = "contract" | "wallet";

function readEnv(name: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} is not set`);
  return raw;
}

function isBase58Pubkey(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return new PublicKey(s).toBytes().length === 32;
  } catch {
    return false;
  }
}

function normalise(chain: BridgeChainKey, kind: Kind, name: string, value: string): string {
  switch (BRIDGE_CHAINS[chain].family) {
    case "evm":
      if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new Error(`${name} must be a 0x EVM address`);
      }
      return getAddress(value);
    case "stellar": {
      const ok =
        kind === "contract"
          ? StrKey.isValidContract(value)
          : StrKey.isValidEd25519PublicKey(value);
      if (!ok) {
        throw new Error(
          `${name} must be a Stellar ${kind === "contract" ? "C… contract id" : "G… account"}`,
        );
      }
      return value;
    }
    case "solana":
      if (!isBase58Pubkey(value)) throw new Error(`${name} must be a base58 Solana public key`);
      return value;
  }
}

/** The Settu bridge contract on `chain` (the quote's verifying contract). */
export function bridgeContractFor(chain: BridgeChainKey): string {
  const name = `BRIDGE_CONTRACT_${chain.toUpperCase()}`;
  return normalise(chain, "contract", name, readEnv(name));
}

/** Where the Settu fee is paid on `chain`. */
export function feeWalletFor(chain: BridgeChainKey): string {
  const name = `FEE_WALLET_${chain.toUpperCase()}`;
  return normalise(chain, "wallet", name, readEnv(name));
}
