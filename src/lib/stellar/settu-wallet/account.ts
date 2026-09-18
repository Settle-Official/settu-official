// Settu sponsors the account reserve and every trustline reserve, so a user
// arrives holding no XLM and can still receive. Builders are pure.

import {
  Account,
  Asset,
  BASE_FEE,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// From the SDK, not the wallet adapter, which would pull in a browser module.
const NETWORK_PASSPHRASE = Networks.PUBLIC;

// Circle's issuer, confirmed against Horizon (home_domain circle.com). Pinned
// because assets on Stellar are impersonated by code alone.
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

// Both keys must sign: the sponsor pays, the new account sources the
// operations that consume the sponsorship.
export function buildSponsoredCreationTx(
  params: SponsoredCreationParams,
): Transaction {
  const { sponsor, newAccountPublicKey } = params;
  const assets = params.assets ?? [STELLAR_USDC];

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

// The sponsor co-signs these, so a payment, signer change or merge smuggled
// alongside must be refused rather than signed.
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
