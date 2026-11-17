/**
 * Live destination checks for the user bridge (spec §8), run after the
 * format checks in ./address pass.
 *
 * - Stellar: the account must exist and hold an authorized trustline to the
 *   chain's USDC. "The chain's USDC" is matched by Stellar Asset Contract id:
 *   a trustline counts only if `Asset(code, issuer).contractId(passphrase)`
 *   equals BRIDGE_CHAINS.stellar.usdc, so no issuer is hardcoded here and a
 *   look-alike "USDC" from another issuer never passes.
 * - Solana: the recipient must be a wallet, not a token account (a USDC mint
 *   sent to a token account's own ATA is unrecoverable) and not a
 *   program-owned data account. The USDC ATA is derived; if it doesn't exist
 *   yet the relayer creates it and its rent goes in the network fee.
 * - EVM: no live check.
 *
 * Every RPC read goes through `LiveCheckDeps`; any read failure throws, so
 * the caller fails closed.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { Asset } from "@stellar/stellar-sdk";
import { CCTP_CONFIG, CCTP_NETWORK } from "../cctp/constants";
import { requireSolanaRpcUrl } from "../solana/config";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";

export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

export type LiveCheckResult =
  | { ok: true; solanaAta?: string; needsSolanaAta?: boolean }
  | {
      ok: false;
      /** `not_wallet` (program-owned, non-token account) is an addition to the brief's three codes. */
      code: "no_account" | "no_trustline" | "token_account" | "not_wallet";
      message: string;
    };

export interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
  is_authorized?: boolean;
}

export interface LiveCheckDeps {
  /** Horizon `/accounts/{g}` body, or null when the account doesn't exist (404). */
  stellarAccount(g: string): Promise<{ balances: HorizonBalance[] } | null>;
  /** Owner program (base58) of a Solana account, or null when it doesn't exist. */
  solanaAccountOwner(address: string): Promise<string | null>;
  /** Defaults to BRIDGE_CHAINS.stellar.usdc. */
  stellarUsdcContractId?: string;
  /** Defaults to BRIDGE_CHAINS.solana.usdc. */
  solanaUsdcMint?: string;
}

/**
 * The owner's associated token account for `mint` under the classic SPL
 * Token program. Derived with the standard ATA seeds
 * [owner, TOKEN_PROGRAM_ID, mint] under the Associated Token Account program
 * — identical to @solana/spl-token's getAssociatedTokenAddressSync (a test
 * pins vectors computed with it). Owners may be off-curve (e.g. multisig
 * vault PDAs); the ATA program supports that. Circle's USDC uses the classic
 * Token program, not Token-2022.
 */
export function deriveUsdcAta(owner: string, mint: string): string {
  const [ata] = PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      new PublicKey(SPL_TOKEN_PROGRAM_ID).toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  return ata.toBase58();
}

function isChainUsdc(b: HorizonBalance, usdcContractId: string): boolean {
  if (b.asset_type !== "credit_alphanum4" && b.asset_type !== "credit_alphanum12") return false;
  if (!b.asset_code || !b.asset_issuer) return false;
  try {
    return (
      new Asset(b.asset_code, b.asset_issuer).contractId(CCTP_CONFIG.stellarNetworkPassphrase) ===
      usdcContractId
    );
  } catch {
    return false;
  }
}

export async function checkDestinationLive(
  chain: BridgeChainKey,
  address: string,
  deps: LiveCheckDeps = defaultLiveCheckDeps(),
): Promise<LiveCheckResult> {
  const family = BRIDGE_CHAINS[chain].family;

  if (family === "stellar") {
    const account = await deps.stellarAccount(address);
    if (!account) {
      return {
        ok: false,
        code: "no_account",
        message:
          "This Stellar account doesn't exist yet. Fund it with XLM and add a USDC trustline, then try again.",
      };
    }
    const usdcId = deps.stellarUsdcContractId ?? BRIDGE_CHAINS.stellar.usdc;
    const line = (account.balances ?? []).find((b) => isChainUsdc(b, usdcId));
    // is_authorized must be explicitly true: an unauthorized line can't receive.
    if (!line || line.is_authorized !== true) {
      return {
        ok: false,
        code: "no_trustline",
        message:
          "This Stellar account can't receive USDC yet. Add a USDC trustline in the wallet (Assets → Add asset → USDC by Circle), then try again.",
      };
    }
    return { ok: true };
  }

  if (family === "solana") {
    const owner = await deps.solanaAccountOwner(address);
    if (owner === SPL_TOKEN_PROGRAM_ID || owner === TOKEN_2022_PROGRAM_ID) {
      return {
        ok: false,
        code: "token_account",
        message: "That's a USDC token account. Paste the wallet address instead.",
      };
    }
    if (owner !== null && owner !== SYSTEM_PROGRAM_ID) {
      return {
        ok: false,
        code: "not_wallet",
        message: "That's a program account, not a wallet. Paste the wallet address instead.",
      };
    }
    const mint = deps.solanaUsdcMint ?? BRIDGE_CHAINS.solana.usdc;
    const ata = deriveUsdcAta(address, mint);
    const ataOwner = await deps.solanaAccountOwner(ata);
    if (ataOwner !== null && ataOwner !== SPL_TOKEN_PROGRAM_ID) {
      // An account at the ATA address not owned by the Token program can't hold USDC.
      throw new Error("Solana USDC ATA address is occupied by a non-token account");
    }
    return { ok: true, solanaAta: ata, needsSolanaAta: ataOwner === null };
  }

  return { ok: true };
}

// ---------------------------------------------------------------- defaults

const HORIZON_TIMEOUT_MS = 15_000;

/** Same switch the hot wallet uses; STELLAR_HORIZON_URL overrides (as elsewhere in the repo). */
export function horizonBaseUrl(): string {
  return (
    process.env.STELLAR_HORIZON_URL ||
    (CCTP_NETWORK === "testnet"
      ? "https://horizon-testnet.stellar.org"
      : "https://horizon.stellar.org")
  );
}

export async function fetchHorizonAccount(
  g: string,
): Promise<{ balances: HorizonBalance[]; [k: string]: unknown } | null> {
  const res = await fetch(`${horizonBaseUrl()}/accounts/${encodeURIComponent(g)}`, {
    signal: AbortSignal.timeout(HORIZON_TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Horizon /accounts failed: ${res.status}`);
  return (await res.json()) as { balances: HorizonBalance[] };
}

export function defaultLiveCheckDeps(): LiveCheckDeps {
  return {
    stellarAccount: fetchHorizonAccount,
    solanaAccountOwner: async (address) => {
      const conn = new Connection(requireSolanaRpcUrl(), "confirmed");
      const info = await conn.getAccountInfo(new PublicKey(address));
      return info ? info.owner.toBase58() : null;
    },
  };
}
