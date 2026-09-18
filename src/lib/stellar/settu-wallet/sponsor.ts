// Server-only. Signs sponsored account creation and trustlines with a key that
// pays reserves and fees, and never holds user funds.

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const NETWORK = Networks.PUBLIC;
import {
  buildSponsoredCreationTx,
  buildSponsoredTrustlineTx,
  isSafeToSponsor,
} from "./account";

export class SponsorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SponsorUnavailableError";
  }
}

const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org";

// Refuse well before empty: a sponsor that runs dry mid-flight strands a
// half-created account, which is worse than declining to start.
const DEFAULT_MIN_XLM = 20;

/** Separate from CCTP_STELLAR_HOT_WALLET_SECRET — this key is reachable from a
 *  public endpoint, so it must not be the one that mints onramp deliveries. */
export function getSponsorKeypair(): Keypair {
  const secret = process.env.SETTU_SPONSOR_SECRET;
  if (!secret) {
    throw new SponsorUnavailableError("SETTU_SPONSOR_SECRET not configured");
  }
  return Keypair.fromSecret(secret);
}

export function horizon(): Horizon.Server {
  return new Horizon.Server(HORIZON_URL);
}

/** True when the account already exists on the ledger. */
export async function accountExists(publicKey: string): Promise<boolean> {
  try {
    await horizon().loadAccount(publicKey);
    return true;
  } catch {
    return false;
  }
}

async function assertSponsorFunded(server: Horizon.Server, sponsor: string) {
  const account = await server.loadAccount(sponsor).catch(() => null);
  if (!account) {
    throw new SponsorUnavailableError("Sponsor account is not funded yet");
  }
  const native = account.balances.find((b) => b.asset_type === "native");
  const floor = Number(process.env.SETTU_SPONSOR_MIN_XLM || DEFAULT_MIN_XLM);
  if (Number(native?.balance ?? "0") < floor) {
    throw new SponsorUnavailableError(
      "Sponsor balance is below its floor; refusing to sponsor",
    );
  }
  return account;
}

/** Sponsor-signed XDR. The new account must add its own signature to submit. */
export async function signSponsoredCreation(
  newAccountPublicKey: string,
  assets?: Asset[],
): Promise<string> {
  const sponsor = getSponsorKeypair();
  const server = horizon();
  const sponsorAccount = await assertSponsorFunded(server, sponsor.publicKey());

  const tx = buildSponsoredCreationTx({
    sponsor: sponsorAccount,
    newAccountPublicKey,
    assets,
  });
  assertSafe(tx, newAccountPublicKey);

  tx.sign(sponsor);
  return tx.toXDR();
}

/** Same, for an account that already exists and wants one more asset. */
export async function signSponsoredTrustline(
  accountPublicKey: string,
  asset: Asset,
): Promise<string> {
  const sponsor = getSponsorKeypair();
  const server = horizon();
  const sponsorAccount = await assertSponsorFunded(server, sponsor.publicKey());

  const tx = buildSponsoredTrustlineTx({
    sponsor: sponsorAccount,
    accountPublicKey,
    asset,
  });
  assertSafe(tx, accountPublicKey);

  tx.sign(sponsor);
  return tx.toXDR();
}

// Belt and braces: these transactions are built here, but the guard runs before
// the sponsor key touches anything, so a future edit can't quietly widen it.
function assertSafe(tx: Transaction, account: string): void {
  if (!isSafeToSponsor(tx, account)) {
    throw new Error("Refusing to sponsor a transaction with other operations");
  }
}

/** Only accounts whose reserves we sponsor — proven on-chain, not from a table. */
export async function isSponsoredByUs(publicKey: string): Promise<boolean> {
  const sponsor = getSponsorKeypair().publicKey();
  const account = await horizon()
    .loadAccount(publicKey)
    .catch(() => null);
  return (account as { sponsor?: string } | null)?.sponsor === sponsor;
}

export class FeeBumpRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeeBumpRejected";
  }
}

/**
 * Pays the fee for a transaction the user already signed.
 * Refuses anything not from one of our accounts — otherwise this is free
 * transaction submission for the whole network.
 */
export async function feeBumpAndSubmit(innerXdr: string) {
  const sponsor = getSponsorKeypair();
  const server = horizon();

  let inner: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(innerXdr, NETWORK);
    // A fee bump cannot wrap another fee bump, and we will not re-wrap ours.
    if (!("operations" in parsed)) {
      throw new FeeBumpRejected("Expected a plain transaction");
    }
    inner = parsed as Transaction;
  } catch (error) {
    throw error instanceof FeeBumpRejected
      ? error
      : new FeeBumpRejected("Could not parse that transaction");
  }

  // Unsigned means we would pay to submit something that cannot succeed.
  if (inner.signatures.length === 0) {
    throw new FeeBumpRejected("Transaction is not signed");
  }
  if (!(await isSponsoredByUs(inner.source))) {
    throw new FeeBumpRejected("That account is not a Settu wallet");
  }

  await assertSponsorFunded(server, sponsor.publicKey());

  const bumped = TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    String(Number(BASE_FEE) * 10),
    inner,
    NETWORK,
  );
  bumped.sign(sponsor);
  return server.submitTransaction(bumped);
}
