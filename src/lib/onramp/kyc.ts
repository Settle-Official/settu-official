/**
 * The identity details Paycrest requires on every onramp order.
 *
 * Paycrest made `source.kyc` mandatory for fiat-funded orders: a person's
 * full name, date of birth (18 or over) and an ID document, and for NGN a
 * BVN or a NIN as well. Orders without it are rejected with a bare "Failed to
 * validate payload", which is what took the onramp down in October 2026.
 * (Source: docs.paycrest.io/api-reference/sender/initiate-payment-order-v2,
 * `V2FiatSource.kyc`.)
 *
 * These details pass straight through to Paycrest with the order. They are
 * never stored, logged or put in an alert: nothing in this file, or in the
 * order route that calls it, may write them anywhere but the outbound
 * request.
 *
 * NGN only for now, which is the only currency the onramp form offers. A
 * NIN is both the ID document and the Nigerian identifier, so it is the
 * shortest path; any other document needs the BVN alongside it.
 */

export type OnrampIdType = "nin" | "passport" | "driverLicense";

/** What the onramp form sends. */
export interface OnrampKycInput {
  /** YYYY-MM-DD, as a date input produces it. */
  readonly birthDate: string;
  readonly idType: OnrampIdType;
  readonly idNumber: string;
  /** Required unless `idType` is "nin". */
  readonly bvn?: string;
}

/** Paycrest's `KYCDetail` for a person, as far as an NGN onramp needs it. */
export interface PaycrestPersonKyc {
  readonly entityType: "person";
  readonly personDetails: {
    readonly fullName: string;
    readonly birthDate: string;
    readonly idDocument: {
      readonly type: "nationalID" | "passport" | "driverLicense";
      readonly number: string;
      readonly issuerCountry: "NG";
    };
    readonly taxId?: {
      readonly type: "BVN";
      readonly value: string;
      readonly country: "NG";
    };
  };
}

export type OnrampKycResult =
  | { readonly ok: true; readonly kyc: PaycrestPersonKyc }
  | { readonly ok: false; readonly error: string };

const ELEVEN_DIGITS = /^\d{11}$/;
// Passport and licence formats vary; this only rules out the obviously wrong.
const DOCUMENT_NUMBER = /^[A-Z0-9][A-Z0-9-]{4,19}$/;
const MIN_AGE = 18;
const MAX_AGE = 120;

const DOCUMENT_TYPE = {
  nin: "nationalID",
  passport: "passport",
  driverLicense: "driverLicense",
} as const;

const fail = (error: string): OnrampKycResult => ({ ok: false, error });

/** Whole years between a YYYY-MM-DD birth date and `today`, both in UTC. */
function ageOn(birthDate: string, today: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  // Date rolls 1995-02-30 over to March: reject anything that didn't survive.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  let age = today.getUTCFullYear() - year;
  const hadBirthday =
    today.getUTCMonth() > month - 1 ||
    (today.getUTCMonth() === month - 1 && today.getUTCDate() >= day);
  if (!hadBirthday) age -= 1;
  return age;
}

/**
 * Validates the form's identity fields and shapes them for Paycrest.
 *
 * `fullName` is the refund account's holder name as the bank returned it,
 * not something typed here: Paycrest rejects an order whose KYC name doesn't
 * match that account, so using the same string keeps them from disagreeing.
 */
export function buildOnrampKyc(
  input: unknown,
  fullName: string,
  today: Date = new Date(),
): OnrampKycResult {
  if (!input || typeof input !== "object") {
    return fail("Identity details are required to buy USDC.");
  }
  const raw = input as Record<string, unknown>;
  const name = fullName.trim();
  if (!name) return fail("Verify your refund account first: its name is used as your full name.");

  const birthDate = typeof raw.birthDate === "string" ? raw.birthDate.trim() : "";
  const age = ageOn(birthDate, today);
  if (age === null || age > MAX_AGE || age < 0) {
    return fail("Enter a valid date of birth.");
  }
  if (age < MIN_AGE) return fail("You must be 18 or over to buy USDC.");

  const idType = raw.idType;
  if (idType !== "nin" && idType !== "passport" && idType !== "driverLicense") {
    return fail("Choose a valid ID type.");
  }

  const typedNumber = typeof raw.idNumber === "string" ? raw.idNumber : "";
  let idNumber: string;
  if (idType === "nin") {
    idNumber = typedNumber.replace(/\s+/g, "");
    if (!ELEVEN_DIGITS.test(idNumber)) return fail("Your NIN must be 11 digits.");
  } else {
    idNumber = typedNumber.trim().toUpperCase().replace(/\s+/g, "");
    if (!DOCUMENT_NUMBER.test(idNumber)) return fail("Enter a valid ID number.");
  }

  let taxId: PaycrestPersonKyc["personDetails"]["taxId"];
  if (idType !== "nin") {
    const bvn = (typeof raw.bvn === "string" ? raw.bvn : "").replace(/\s+/g, "");
    if (!ELEVEN_DIGITS.test(bvn)) {
      return fail("Your BVN must be 11 digits. It's required with a passport or driver's licence.");
    }
    taxId = { type: "BVN", value: bvn, country: "NG" };
  }

  return {
    ok: true,
    kyc: {
      entityType: "person",
      personDetails: {
        fullName: name,
        birthDate,
        idDocument: { type: DOCUMENT_TYPE[idType], number: idNumber, issuerCountry: "NG" },
        ...(taxId ? { taxId } : {}),
      },
    },
  };
}

/**
 * The specific reason inside Paycrest's "Failed to validate payload", if it
 * sent one (`data.message`, or a list of them), so the user is told what to
 * fix (e.g. a name that doesn't match the refund account) instead of the bare
 * message.
 */
export function paycrestValidationDetail(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const data = (details as { data?: unknown }).data;
  const items = Array.isArray(data) ? data : data ? [data] : [];
  const messages = items
    .map((item) =>
      item && typeof item === "object" && typeof (item as { message?: unknown }).message === "string"
        ? ((item as { message: string }).message).trim()
        : "",
    )
    .filter(Boolean);
  return messages.length > 0 ? messages.join("; ") : null;
}
