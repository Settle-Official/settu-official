/**
 * The API waitlist form: its options and the one validator both the page and
 * the route use, so the two can't drift apart.
 */

export const NEEDS = [
  { value: "offramp", label: "Offramp — stablecoins to local currency" },
  { value: "onramp", label: "Onramp — local currency to stablecoins" },
  { value: "both", label: "Both" },
] as const;

export const BUILDING = [
  { value: "wallet", label: "Wallet" },
  { value: "exchange", label: "Exchange" },
  { value: "payroll", label: "Payroll / payments" },
  { value: "marketplace", label: "Marketplace" },
  { value: "fintech", label: "Fintech app" },
  { value: "other", label: "Other" },
] as const;

export const MARKETS = [
  { value: "NGN", label: "Nigeria (NGN)" },
  { value: "KES", label: "Kenya (KES)" },
  { value: "UGX", label: "Uganda (UGX)" },
  { value: "TZS", label: "Tanzania (TZS)" },
  { value: "XOF", label: "CFA franc (XOF)" },
  { value: "other", label: "Other" },
] as const;

export const CHAINS = [
  { value: "stellar", label: "Stellar" },
  { value: "base", label: "Base" },
  { value: "arbitrum", label: "Arbitrum" },
  { value: "ethereum", label: "Ethereum" },
  { value: "optimism", label: "Optimism" },
  { value: "polygon", label: "Polygon" },
  { value: "solana", label: "Solana" },
  { value: "other", label: "Other" },
] as const;

export const VOLUMES = [
  { value: "<10k", label: "Under $10k" },
  { value: "10k-100k", label: "$10k – $100k" },
  { value: "100k-1m", label: "$100k – $1M" },
  { value: "1m+", label: "$1M+" },
] as const;

type Opt = readonly { readonly value: string; readonly label: string }[];
const valuesOf = (o: Opt) => new Set(o.map((x) => x.value));
const NEED_SET = valuesOf(NEEDS), BUILD_SET = valuesOf(BUILDING), MARKET_SET = valuesOf(MARKETS),
  CHAIN_SET = valuesOf(CHAINS), VOLUME_SET = valuesOf(VOLUMES);

export const LIMITS = { name: 120, company: 160, useCase: 2000, heardFrom: 300 } as const;

export interface WaitlistEntry {
  readonly email: string;
  readonly name: string;
  readonly company: string;
  readonly need: string;
  readonly building: string;
  readonly markets: readonly string[];
  readonly chains: readonly string[];
  readonly volume: string;
  readonly useCase: string;
  readonly heardFrom: string;
}

export type FieldErrors = Partial<Record<keyof WaitlistEntry, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
// Only known option values survive; anything else is dropped, never echoed.
const pickList = (v: unknown, allowed: Set<string>) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && allowed.has(x)))] : [];

export function validateWaitlist(input: unknown):
  | { ok: true; entry: WaitlistEntry }
  | { ok: false; errors: FieldErrors } {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const entry: WaitlistEntry = {
    email: str(b.email, 254).toLowerCase(),
    name: str(b.name, LIMITS.name),
    company: str(b.company, LIMITS.company),
    need: str(b.need, 20),
    building: str(b.building, 20),
    markets: pickList(b.markets, MARKET_SET),
    chains: pickList(b.chains, CHAIN_SET),
    volume: str(b.volume, 20),
    useCase: str(b.useCase, LIMITS.useCase),
    heardFrom: str(b.heardFrom, LIMITS.heardFrom),
  };
  const errors: FieldErrors = {};
  if (!EMAIL.test(entry.email)) errors.email = "Enter a valid email address.";
  if (!entry.name) errors.name = "Tell us your name.";
  if (!NEED_SET.has(entry.need)) errors.need = "Choose what you need.";
  if (!BUILD_SET.has(entry.building)) errors.building = "Choose what you're building.";
  if (entry.volume && !VOLUME_SET.has(entry.volume)) errors.volume = "Choose a volume range.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, entry };
}

const labelOf = (o: Opt, v: string) => o.find((x) => x.value === v)?.label ?? v;

/** The sheet row, in the header order of SHEET_HEADERS. */
export const SHEET_HEADERS = [
  "Submitted at (UTC)", "Email", "Name", "Company", "Needs", "Building",
  "Markets", "Chains", "Monthly volume", "Use case", "Heard about us",
] as const;

/**
 * Cells that start with = + - or @ are formulas to Google Sheets. A sign-up
 * could otherwise plant one (formula injection), so those get a leading quote.
 */
function cell(v: string): string {
  return /^[=+\-@]/.test(v) ? `'${v}` : v;
}

export function toSheetRow(e: WaitlistEntry, at: Date): string[] {
  return [
    at.toISOString().replace("T", " ").slice(0, 19),
    e.email,
    e.name,
    e.company,
    labelOf(NEEDS, e.need),
    labelOf(BUILDING, e.building),
    e.markets.map((m) => labelOf(MARKETS, m)).join(", "),
    e.chains.map((c) => labelOf(CHAINS, c)).join(", "),
    e.volume ? labelOf(VOLUMES, e.volume) : "",
    e.useCase,
    e.heardFrom,
  ].map(cell);
}
