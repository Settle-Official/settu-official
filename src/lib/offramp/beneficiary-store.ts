// Where a settled offramp paid out, kept so "Repeat transfer" works.
//
// Lives in Postgres rather than Redis: it is permanent per-user data that
// would otherwise grow the Redis store, and Redis's own copy (order meta)
// expires after 48h — which is why history older than that cannot repeat.
//
// Keyed by order id, never by wallet. A wallet address is public, so a
// per-wallet key would make bank details enumerable by anyone.

import { serviceFetch, serviceWrite } from "../api/server";

export interface Beneficiary {
  institution: string;
  accountIdentifier: string;
  accountName: string;
  currency: string;
}

interface BeneficiaryWire {
  institution: string;
  account_identifier: string;
  account_name: string;
  currency: string;
}

export function toWire(beneficiary: Beneficiary): BeneficiaryWire {
  return {
    institution: beneficiary.institution,
    account_identifier: beneficiary.accountIdentifier,
    account_name: beneficiary.accountName,
    currency: beneficiary.currency,
  };
}

export function fromWire(wire: BeneficiaryWire): Beneficiary {
  return {
    institution: wire.institution,
    accountIdentifier: wire.account_identifier,
    accountName: wire.account_name,
    currency: wire.currency,
  };
}

/** Every field is required server-side, so an incomplete meta is not sent. */
export function isComplete(value: Partial<Beneficiary> | null | undefined): boolean {
  return (
    !!value?.institution &&
    !!value?.accountIdentifier &&
    !!value?.accountName &&
    !!value?.currency
  );
}

// Called from the settlement webhook, which must ack fast; swallowed, since
// losing this costs a Repeat button, not money.
export async function recordBeneficiary(
  orderId: string,
  beneficiary: Beneficiary,
): Promise<boolean> {
  return serviceWrite(
    `/offramp/orders/${encodeURIComponent(orderId)}/beneficiary`,
    toWire(beneficiary),
    8_000,
    "PUT",
  );
}

/** Short: a user is waiting on the receipt, and a sleeping backend must not hold it. */
export async function getBeneficiary(orderId: string): Promise<Beneficiary | null> {
  const { beneficiary } = await serviceFetch<{ beneficiary: BeneficiaryWire | null }>(
    `/offramp/orders/${encodeURIComponent(orderId)}/beneficiary`,
    { timeoutMs: 4_000 },
  );
  return beneficiary ? fromWire(beneficiary) : null;
}
