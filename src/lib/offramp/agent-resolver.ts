import { fetchCurrencies, fetchInstitutions, verifyAccount } from "./paycrest-directory";
import { sourceChainOptions, type OfframpSourceChainKey } from "./source-chain-options";
import { validateAmount } from "./utils/validation";

export interface AgentOrderExtraction {
  amount: string | null;
  token: string | null;
  sourceChain: string | null;
  destinationCurrency: string | null;
  institutionName: string | null;
  accountIdentifier: string | null;
}

export interface ResolvedAgentOrder {
  amount: string;
  token: string;
  sourceChain: OfframpSourceChainKey;
  beneficiary: {
    institution: string;
    accountIdentifier: string;
    accountName: string;
    currency: string;
    memo?: string;
  };
}

export type ResolveResult =
  | { status: "resolved"; order: ResolvedAgentOrder }
  | { status: "clarify"; message: string }
  | { status: "recap"; missing: string[] };

const FIELD_LABELS: Record<keyof AgentOrderExtraction, string> = {
  amount: "the amount",
  token: "which token",
  sourceChain: "which chain to send from",
  destinationCurrency: "the destination currency",
  institutionName: "the recipient's bank",
  accountIdentifier: "the account number",
};

function missingFields(extraction: AgentOrderExtraction): (keyof AgentOrderExtraction)[] {
  return (Object.keys(FIELD_LABELS) as (keyof AgentOrderExtraction)[]).filter(
    (key) => !extraction[key],
  );
}

/**
 * The ask-vs-reject threshold, kept deterministic and LLM-independent so
 * it's fully unit-testable: 1-2 missing fields gets a single targeted
 * question; 3+ gets one recap message listing everything still needed,
 * rather than an interrogation one field at a time.
 */
export function classifyExtraction(
  extraction: AgentOrderExtraction,
): { status: "complete" } | { status: "clarify"; message: string } | { status: "recap"; missing: string[] } {
  const missing = missingFields(extraction);
  if (missing.length === 0) return { status: "complete" };
  if (missing.length <= 2) {
    const labels = missing.map((key) => FIELD_LABELS[key]);
    return { status: "clarify", message: `What's ${labels.join(" and ")}?` };
  }
  return { status: "recap", missing: missing.map((key) => FIELD_LABELS[key]) };
}

/** Case-insensitive exact match first, then substring, else ambiguous/none. */
function matchInstitution(
  institutions: { code: string; name: string }[],
  freeText: string,
): { code: string } | "none" | "ambiguous" {
  const needle = freeText.trim().toLowerCase();
  const exact = institutions.filter((i) => i.name.toLowerCase() === needle);
  if (exact.length === 1) return { code: exact[0].code };
  const contains = institutions.filter(
    (i) => i.name.toLowerCase().includes(needle) || needle.includes(i.name.toLowerCase()),
  );
  if (contains.length === 1) return { code: contains[0].code };
  if (contains.length > 1) return "ambiguous";
  return "none";
}

export async function resolveAgentOrder(
  extraction: AgentOrderExtraction,
): Promise<ResolveResult> {
  const classified = classifyExtraction(extraction);
  if (classified.status !== "complete") return classified;

  // All six fields are non-null past this point (classifyExtraction gated it).
  const amount = extraction.amount!;
  const token = extraction.token!;
  const sourceChainRaw = extraction.sourceChain!;
  const currencyRaw = extraction.destinationCurrency!.toUpperCase();
  const institutionName = extraction.institutionName!;
  const accountIdentifier = extraction.accountIdentifier!;

  if (!validateAmount(amount)) {
    return { status: "clarify", message: "What amount would you like to offramp?" };
  }

  const enabledChains = sourceChainOptions();
  const chainMatch = enabledChains.find(
    (c) => c.code.toLowerCase() === sourceChainRaw.toLowerCase(),
  );
  if (!chainMatch) {
    const names = enabledChains.map((c) => c.name).join(", ");
    return {
      status: "clarify",
      message: `I can offramp from ${names} — which one did you mean?`,
    };
  }

  const currencies = await fetchCurrencies();
  const currencyMatch = currencies.find((c) => c.code.toUpperCase() === currencyRaw);
  if (!currencyMatch) {
    const supported = currencies.map((c) => c.code).join(", ") || "a supported currency";
    return {
      status: "clarify",
      message: `I can only pay out in ${supported} right now — which currency did you mean?`,
    };
  }

  const institutions = await fetchInstitutions(currencyMatch.code);
  const institutionMatch = matchInstitution(institutions, institutionName);
  if (institutionMatch === "none") {
    return {
      status: "clarify",
      message: `I couldn't find "${institutionName}" as a ${currencyMatch.code} bank — which bank did you mean?`,
    };
  }
  if (institutionMatch === "ambiguous") {
    return {
      status: "clarify",
      message: `A few banks match "${institutionName}" — can you give the exact bank name?`,
    };
  }

  const accountName = await verifyAccount(institutionMatch.code, accountIdentifier);
  if (!accountName) {
    return {
      status: "clarify",
      message: `I couldn't verify a ${institutionName} account at ${accountIdentifier} — please double check the account number.`,
    };
  }

  return {
    status: "resolved",
    order: {
      amount,
      token,
      sourceChain: chainMatch.code,
      beneficiary: {
        institution: institutionMatch.code,
        accountIdentifier,
        accountName,
        currency: currencyMatch.code,
      },
    },
  };
}
