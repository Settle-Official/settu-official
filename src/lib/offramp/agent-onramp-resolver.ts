import { fetchCurrencies, fetchInstitutions, verifyAccount } from "./paycrest-directory";
import { matchInstitution } from "./agent-resolver";
import { validateAmount, validateAddress } from "./utils/validation";

export interface OnrampAgentExtraction {
  fiatAmount: string | null;
  fiatCurrency: string | null;
  destinationStellarAddress: string | null;
  refundInstitutionName: string | null;
  refundAccountIdentifier: string | null;
}

export interface ResolvedOnrampOrder {
  fiatAmount: string;
  currency: string;
  destinationAddress: string;
  refundAccount: {
    institution: string;
    accountIdentifier: string;
    accountName: string;
    currency: string;
  };
}

export type OnrampResolveResult =
  | { status: "resolved"; order: ResolvedOnrampOrder }
  | { status: "clarify"; message: string }
  | { status: "recap"; missing: string[] };

const FIELD_LABELS: Record<keyof OnrampAgentExtraction, string> = {
  fiatAmount: "the amount",
  fiatCurrency: "which currency you're paying in",
  destinationStellarAddress: "the Stellar address to receive your USDC",
  refundInstitutionName: "your refund bank",
  refundAccountIdentifier: "your refund account number",
};

function missingFields(
  extraction: OnrampAgentExtraction,
): (keyof OnrampAgentExtraction)[] {
  return (Object.keys(FIELD_LABELS) as (keyof OnrampAgentExtraction)[]).filter(
    (key) => !extraction[key],
  );
}

/**
 * Same ask-vs-recap threshold as offramp's classifyExtraction, for the same
 * reason: 1-2 missing fields gets one targeted question, 3+ gets a single
 * recap rather than an interrogation one field at a time.
 */
export function classifyOnrampExtraction(
  extraction: OnrampAgentExtraction,
): { status: "complete" } | { status: "clarify"; message: string } | { status: "recap"; missing: string[] } {
  const missing = missingFields(extraction);
  if (missing.length === 0) return { status: "complete" };
  if (missing.length <= 2) {
    const labels = missing.map((key) => FIELD_LABELS[key]);
    return { status: "clarify", message: `What's ${labels.join(" and ")}?` };
  }
  return { status: "recap", missing: missing.map((key) => FIELD_LABELS[key]) };
}

export interface ResolveOnrampOptions {
  /**
   * The user's currently connected Stellar wallet address, if any. Onramp's
   * destination is always Stellar regardless of which chain is selected for
   * offramp elsewhere in the app, so this is specifically the Stellar
   * Wallets Kit connection, not whatever externalWallet is active.
   */
  connectedStellarAddress?: string | null;
}

// What the extraction schema instructs the model to emit when the user
// refers to their own wallet ("my connected wallet", "send it to my
// wallet") instead of stating an address outright — see the parse route's
// schema description for destinationStellarAddress.
const CONNECTED_WALLET_SENTINEL = "connected";

export async function resolveOnrampOrder(
  extraction: OnrampAgentExtraction,
  opts: ResolveOnrampOptions = {},
): Promise<OnrampResolveResult> {
  const classified = classifyOnrampExtraction(extraction);
  if (classified.status !== "complete") return classified;

  // All five fields are non-null past this point (classifyOnrampExtraction gated it).
  const fiatAmount = extraction.fiatAmount!;
  const currencyRaw = extraction.fiatCurrency!.toUpperCase();
  const refundInstitutionName = extraction.refundInstitutionName!;
  const refundAccountIdentifier = extraction.refundAccountIdentifier!;

  if (!validateAmount(fiatAmount)) {
    return { status: "clarify", message: "What amount would you like to onramp?" };
  }

  let destinationAddress = extraction.destinationStellarAddress!;
  if (destinationAddress.trim().toLowerCase() === CONNECTED_WALLET_SENTINEL) {
    if (!opts.connectedStellarAddress) {
      return {
        status: "clarify",
        message: "You don't have a Stellar wallet connected — connect one, or give me the Stellar address to send the USDC to.",
      };
    }
    destinationAddress = opts.connectedStellarAddress;
  }

  if (!validateAddress(destinationAddress, "stellar")) {
    return {
      status: "clarify",
      message: "That doesn't look like a valid Stellar address — it should start with G and be 56 characters. What's the right one?",
    };
  }

  const currencies = await fetchCurrencies();
  const currencyMatch = currencies.find((c) => c.code.toUpperCase() === currencyRaw);
  if (!currencyMatch) {
    const supported = currencies.map((c) => c.code).join(", ") || "a supported currency";
    return {
      status: "clarify",
      message: `I can only take payment in ${supported} right now — which currency did you mean?`,
    };
  }

  const institutions = await fetchInstitutions(currencyMatch.code);
  const institutionMatch = matchInstitution(institutions, refundInstitutionName);
  if (institutionMatch === "none") {
    return {
      status: "clarify",
      message: `I couldn't find "${refundInstitutionName}" as a ${currencyMatch.code} bank — which bank should I use for refunds?`,
    };
  }
  if (institutionMatch === "ambiguous") {
    return {
      status: "clarify",
      message: `A few banks match "${refundInstitutionName}" — can you give the exact bank name for your refund account?`,
    };
  }

  const accountName = await verifyAccount(institutionMatch.code, refundAccountIdentifier);
  if (!accountName) {
    return {
      status: "clarify",
      message: `I couldn't verify a ${refundInstitutionName} account at ${refundAccountIdentifier} — please double check the refund account number.`,
    };
  }

  return {
    status: "resolved",
    order: {
      fiatAmount,
      currency: currencyMatch.code,
      destinationAddress,
      refundAccount: {
        institution: institutionMatch.code,
        accountIdentifier: refundAccountIdentifier,
        accountName,
        currency: currencyMatch.code,
      },
    },
  };
}
