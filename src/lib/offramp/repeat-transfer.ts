// Carries a past transfer's details to a fresh offramp form.
//
// sessionStorage, not the URL: the payload holds a bank account number, and a
// URL would put that in browser history, referrers and any logging in between.

const KEY = "settu:repeat-transfer";

export interface RepeatTransfer {
  amountUsdc: string;
  currency: string;
  institution: string;
  accountIdentifier: string;
  accountName: string;
  sourceChain?: string;
}

/** Narrow an unknown blob, so a stale or tampered entry can't reach the form. */
function parse(raw: string): RepeatTransfer | null {
  try {
    const value = JSON.parse(raw);
    const required = [
      value?.amountUsdc,
      value?.currency,
      value?.institution,
      value?.accountIdentifier,
      value?.accountName,
    ];
    if (required.some((field) => typeof field !== "string" || field === "")) {
      return null;
    }
    return {
      amountUsdc: value.amountUsdc,
      currency: value.currency,
      institution: value.institution,
      accountIdentifier: value.accountIdentifier,
      accountName: value.accountName,
      ...(typeof value.sourceChain === "string"
        ? { sourceChain: value.sourceChain }
        : {}),
    };
  } catch {
    return null;
  }
}

export function stashRepeat(transfer: RepeatTransfer): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(transfer));
  } catch {
    // Private browsing can refuse storage; the form just opens empty.
  }
}

/** Read-and-clear, so a reload doesn't silently refill the form again. */
export function consumeRepeat(): RepeatTransfer | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return raw ? parse(raw) : null;
  } catch {
    return null;
  }
}

/** Only rows this browser ran carry bank details, so not every row can repeat. */
export function canRepeat(row: {
  bank?: string;
  accountName?: string;
  accountNumber?: string;
  kind: "offramp" | "onramp";
}): boolean {
  return (
    row.kind === "offramp" &&
    !!row.bank &&
    !!row.accountName &&
    !!row.accountNumber
  );
}

export const _KEY_FOR_TESTS = KEY;
export const _parseForTests = parse;
