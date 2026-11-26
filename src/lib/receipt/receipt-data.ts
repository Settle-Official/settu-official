// Turns a history row into the lines a receipt shows.
//
// Pure and separate from the canvas drawing, so the wording and the
// redaction rules can be tested without a DOM.

// Relative, not "@/": this module is covered by tests, and the test runner's
// resolver only rewrites relative specifiers.
import { formatFiat } from "../format/currency";

export interface ReceiptSource {
  readonly kind: "offramp" | "onramp";
  readonly usdc: number;
  readonly fiatAmount?: string;
  readonly currency: string;
  readonly status: "pending" | "completed" | "failed";
  readonly timestamp: number;
  readonly bank?: string;
  readonly accountName?: string;
  readonly accountNumber?: string;
  readonly txHash?: string;
  readonly orderId?: string;
}

export interface ReceiptField {
  readonly label: string;
  readonly value: string;
}

export interface Receipt {
  readonly title: string;
  readonly headline: string;
  readonly status: string;
  readonly fields: readonly ReceiptField[];
  readonly reference: string;
}

const STATUS_WORD: Record<ReceiptSource["status"], string> = {
  completed: "Completed",
  pending: "In progress",
  failed: "Failed",
};

/** Last four only: a receipt gets shared, and a full number need not travel. */
export function maskAccount(accountNumber: string): string {
  const digits = accountNumber.replace(/\s/g, "");
  if (digits.length <= 4) return digits;
  return `••••${digits.slice(-4)}`;
}

/** Middle-truncated so both ends stay checkable against an explorer. */
export function shortenReference(reference: string): string {
  if (reference.length <= 20) return reference;
  return `${reference.slice(0, 10)}…${reference.slice(-6)}`;
}

function formatWhen(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function buildReceipt(source: ReceiptSource): Receipt {
  const fiat = Number(source.fiatAmount);
  const hasFiat = Number.isFinite(fiat) && fiat > 0;
  const sent = `${source.usdc.toFixed(2)} USDC`;
  const received = hasFiat ? formatFiat(fiat, source.currency) : "—";

  const fields: ReceiptField[] = [
    { label: source.kind === "offramp" ? "Sent" : "Paid", value: sent },
    { label: "Received", value: received },
  ];

  if (source.bank) fields.push({ label: "Bank", value: source.bank });
  if (source.accountName) {
    fields.push({ label: "Account name", value: source.accountName });
  }
  if (source.accountNumber) {
    fields.push({ label: "Account", value: maskAccount(source.accountNumber) });
  }
  fields.push({ label: "Date", value: formatWhen(source.timestamp) });

  // The order id is what support can look up; the hash is the on-chain proof.
  const reference = source.orderId || source.txHash || "—";

  return {
    title: source.kind === "offramp" ? "Withdrawal receipt" : "Deposit receipt",
    headline: hasFiat ? received : sent,
    status: STATUS_WORD[source.status],
    fields,
    reference: shortenReference(reference),
  };
}
