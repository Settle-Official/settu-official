/**
 * New server-signing Stellar wallet, used only to submit `mint_and_forward` on
 * the CCTP Forwarder for the onramp Base→Stellar leg. Pays XLM gas only —
 * mint_and_forward is atomic (mints then forwards in one Soroban invocation),
 * so this wallet never custodies bridged USDC even momentarily.
 *
 * Env:
 *   CCTP_STELLAR_HOT_WALLET_SECRET — Stellar secret key (S...), server secret
 *   CCTP_STELLAR_MIN_GAS_XLM       — optional XLM floor (default 2)
 *   CCTP_STELLAR_WARN_GAS_XLM      — optional low-balance alert level (default 10)
 *
 * The user bridge's Stellar destination mints through the same Forwarder
 * but signs with its own relayer ("bridge" signer):
 *   BRIDGE_STELLAR_RELAYER_SECRET  — Stellar secret key (S...)
 *   BRIDGE_STELLAR_MIN_GAS_XLM     — optional XLM floor (default 2)
 *   BRIDGE_STELLAR_WARN_GAS_XLM    — optional alert level (default 10)
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { CCTP_CONFIG } from "./constants";
import { reportGasBalance } from "../notify/gas-alert";

/** "onramp": the existing CCTP hot wallet (default). "bridge": the user-bridge relayer. */
export type StellarMintSigner = "onramp" | "bridge";

const SIGNER_ENV: Record<StellarMintSigner, { secret: string; floor: string; warn: string; wallet: string }> = {
  onramp: {
    secret: "CCTP_STELLAR_HOT_WALLET_SECRET",
    floor: "CCTP_STELLAR_MIN_GAS_XLM",
    warn: "CCTP_STELLAR_WARN_GAS_XLM",
    wallet: "Stellar relayer",
  },
  bridge: {
    secret: "BRIDGE_STELLAR_RELAYER_SECRET",
    floor: "BRIDGE_STELLAR_MIN_GAS_XLM",
    warn: "BRIDGE_STELLAR_WARN_GAS_XLM",
    wallet: "Bridge Stellar relayer",
  },
};

export class CctpGasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CctpGasError";
  }
}

export function getCctpStellarAccount(signer: StellarMintSigner = "onramp"): StellarSdk.Keypair {
  const envVar = SIGNER_ENV[signer].secret;
  const secret = process.env[envVar];
  if (!secret) {
    throw new Error(`${envVar} not configured`);
  }
  return StellarSdk.Keypair.fromSecret(secret);
}

/** Refuses (throws) rather than risk broadcasting a tx the wallet can't afford. */
export async function assertStellarGasFloor(signer: StellarMintSigner = "onramp"): Promise<void> {
  const env = SIGNER_ENV[signer];
  const account = getCctpStellarAccount(signer);
  const server = new StellarSdk.rpc.Server(CCTP_CONFIG.stellarRpcUrl);
  const onchainAccount = await server.getAccount(account.publicKey());
  const horizonBaseUrl = CCTP_CONFIG.stellarRpcUrl.includes("testnet")
    ? "https://horizon-testnet.stellar.org"
    : "https://horizon.stellar.org";
  const horizonBalance = await fetch(
    `${horizonBaseUrl}/accounts/${account.publicKey()}`,
  ).then((r) => r.json());
  const nativeBalance = horizonBalance?.balances?.find(
    (b: any) => b.asset_type === "native",
  );
  const xlmBalance = parseFloat(nativeBalance?.balance ?? "0");
  const floor = parseFloat(process.env[env.floor] || "2");
  await reportGasBalance({
    wallet: env.wallet,
    address: account.publicKey(),
    unit: "XLM",
    balance: xlmBalance,
    floor,
    warn: parseFloat(process.env[env.warn] || "10"),
  });
  if (xlmBalance < floor) {
    throw new CctpGasError(
      `${signer === "bridge" ? "Bridge Stellar relayer" : "CCTP Stellar hot wallet"} XLM balance ${xlmBalance} below floor ${floor}; refusing to submit`,
    );
  }
  // onchainAccount is fetched to fail fast if the account doesn't exist/isn't funded yet.
  void onchainAccount;
}
