// Sponsored account creation and trustlines for a Settu wallet.
//
// A new Stellar account needs a base reserve, and every asset it can hold needs
// a trustline reserve on top. Settu sponsors both, so a user arrives with no
// XLM and can still receive immediately.
//
// The builders are pure: they take a loaded sponsor Account and return an
// unsigned transaction, so the operation shape can be tested without a network.

import {
  Account,
  Asset,
  BASE_FEE,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// From the SDK rather than the wallet adapter: these builders stay pure, and
// importing the adapter would drag a browser module into them.
const NETWORK_PASSPHRASE = Networks.PUBLIC;

// Circle's USDC issuer, confirmed against Horizon: home_domain circle.com, and
// ~2.4M holders against the next USDC issuer's ~3.5k. Assets are impersonated
// on Stellar by code alone, so this is pinned rather than looked up by code.
export const STELLAR_USDC_ISSUER =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

export const STELLAR_USDC = new Asset("USDC", STELLAR_USDC_ISSUER);

// Generous against a busy ledger; unused fee is not charged.
const FEE_MULTIPLIER = 4;

function builder(sponsor: Account, operationCount: number): TransactionBuilder {
  return new TransactionBuilder(sponsor, {
    fee: String(Number(BASE_FEE) * Math.max(operationCount, 1) * FEE_MULTIPLIER),
    networkPassphrase: NETWORK_PASSPHRASE,
  });
}

export interface SponsoredCreationParams {
  sponsor: Account;
  newAccountPublicKey: string;
  /** Trustlines to open at creation. Defaults to USDC alone. */
  assets?: Asset[];
}

/**
 * Create the account and open its first trustlines, all sponsored.
 *
 * Everything between begin/end sponsoring has its reserve paid by the sponsor,
 * so the new account holds no XLM of its own. Both keys must sign: the sponsor
 * because it pays, the new account because it is the source of the operations
 * that consume the sponsorship.
 */
export function buildSponsoredCreationTx(
  params: SponsoredCreationParams,
): Transaction {
  const { sponsor, newAccountPublicKey } = params;
  const assets = params.assets ?? [STELLAR_USDC];
  const sponsorId = sponsor.accountId();

  const tx = builder(sponsor, assets.length + 3)
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: newAccountPublicKey,
      }),
    )
    // Zero starting balance: the reserve is the sponsor's, not a gift of XLM.
    .addOperation(
      Operation.createAccount({
        destination: newAccountPublicKey,
        startingBalance: "0",
      }),
    );

  for (const asset of assets) {
    tx.addOperation(
      Operation.changeTrust({ asset, source: newAccountPublicKey }),
    );
  }

  return tx
    .addOperation(
      Operation.endSponsoringFutureReserves({ source: newAccountPublicKey }),
    )
    .setTimeout(180)
    .build();
}

export interface SponsoredTrustlineParams {
  sponsor: Account;
  accountPublicKey: string;
  asset: Asset;
}

/** Open one more sponsored trustline on an account that already exists. */
export function buildSponsoredTrustlineTx(
  params: SponsoredTrustlineParams,
): Transaction {
  const { sponsor, accountPublicKey, asset } = params;

  return builder(sponsor, 3)
    .addOperation(
      Operation.beginSponsoringFutureReserves({ sponsoredId: accountPublicKey }),
    )
    .addOperation(Operation.changeTrust({ asset, source: accountPublicKey }))
    .addOperation(
      Operation.endSponsoringFutureReserves({ source: accountPublicKey }),
    )
    .setTimeout(180)
    .build();
}

/**
 * True when every operation only creates the named account or its trustlines.
 *
 * The sponsor signs these, so anything else reaching it — a payment, a signer
 * change, a merge — must be refused rather than co-signed.
 */
export function isSafeToSponsor(
  tx: Transaction,
  newAccountPublicKey: string,
): boolean {
  const allowed = new Set([
    "beginSponsoringFutureReserves",
    "endSponsoringFutureReserves",
    "changeTrust",
    "createAccount",
  ]);

  return tx.operations.every((op) => {
    if (!allowed.has(op.type)) return false;
    // Operations that consume the sponsorship must belong to the new account.
    if (op.source && op.source !== newAccountPublicKey) return false;
    if (op.type === "createAccount" && op.destination !== newAccountPublicKey) {
      return false;
    }
    if (
      op.type === "beginSponsoringFutureReserves" &&
      op.sponsoredId !== newAccountPublicKey
    ) {
      return false;
    }
    return true;
  });
}
