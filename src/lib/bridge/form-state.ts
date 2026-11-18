/**
 * The bridge form's state, as a pure reducer (spec §4, plan Task 19).
 *
 * Wallet addresses arrive from the app's wallet hooks via `walletsChanged`,
 * keyed by chain family, so each card's wallet follows its chain: swapping
 * the chains swaps which wallet each card shows without any extra state.
 *
 * Quotes are tagged with `quoteKey(state)` when requested; a response whose
 * key no longer matches the inputs is dropped, so a slow response for an old
 * amount can never overwrite the price for the current one.
 */

import { BRIDGE_CHAINS, type BridgeChainKey, type ChainFamily } from "./chains";
import { validateDestinationAddress } from "./address";
import type { QuoteSuccess, NetworkFeeMode } from "./build-quote";
import type { Speed } from "./quote-math";

/** The localStorage key for addresses a user has bridged to before (spec §8). */
export const knownAddressesKey = (user: string) => `settu:bridge-known:${user}`;

/** Smallest amount the form accepts, in USDC (spec §12 leaves it to the builder). */
export const MIN_BRIDGE_USDC = 1;

export type LoadedQuote = QuoteSuccess;

export type FamilyWallets = Partial<Record<ChainFamily, string>>;

export interface BridgeFormState {
  readonly source: BridgeChainKey;
  readonly dest: BridgeChainKey;
  readonly amount: string;
  readonly speed: Speed;
  readonly networkFeeMode: NetworkFeeMode;
  readonly wallets: FamilyWallets;
  /** Send to the connected destination wallet (true) or the pasted address. */
  readonly useConnectedDest: boolean;
  readonly pastedAddress: string;
  /** Lower-cased addresses this user has bridged to before. */
  readonly knownAddresses: readonly string[];
  readonly firstTimeConfirmed: boolean;
  readonly quote: LoadedQuote | null;
  readonly quoteError: { readonly code: string; readonly message: string } | null;
  readonly notice: string | null;
}

export type BridgeFormAction =
  | { type: "setSource"; chain: BridgeChainKey }
  | { type: "setDest"; chain: BridgeChainKey }
  | { type: "swap" }
  | { type: "setAmount"; amount: string }
  | { type: "setSpeed"; speed: Speed }
  | { type: "setNetworkFeeMode"; mode: NetworkFeeMode }
  | { type: "setPastedAddress"; address: string }
  | { type: "useConnectedDest" }
  | { type: "walletsChanged"; wallets: FamilyWallets }
  | { type: "knownAddressesLoaded"; addresses: readonly string[] }
  | { type: "quoteLoaded"; key: string; quote: LoadedQuote }
  | { type: "quoteFailed"; key: string; code: string; message: string }
  | { type: "confirmFirstTime" };

export function initialBridgeForm(source: BridgeChainKey, dest: BridgeChainKey): BridgeFormState {
  return {
    source,
    dest,
    amount: "",
    speed: "fast",
    networkFeeMode: "usdc",
    wallets: {},
    useConnectedDest: true,
    pastedAddress: "",
    knownAddresses: [],
    firstTimeConfirmed: false,
    quote: null,
    quoteError: null,
    notice: null,
  };
}

const family = (c: BridgeChainKey) => BRIDGE_CHAINS[c].family;
const label = (c: BridgeChainKey) => BRIDGE_CHAINS[c].label;

export function sourceWalletOf(s: BridgeFormState): string | undefined {
  return s.wallets[family(s.source)];
}

export function destWalletOf(s: BridgeFormState): string | undefined {
  return s.wallets[family(s.dest)];
}

/** Where the USDC goes: the connected wallet, or the pasted address. Empty when neither. */
export function recipientOf(s: BridgeFormState): string {
  if (!s.useConnectedDest) return s.pastedAddress.trim();
  return destWalletOf(s) ?? "";
}

/** The pasted address's validation message, or null when it's valid or not in use. */
export function addressError(s: BridgeFormState): string | null {
  if (s.useConnectedDest || !s.pastedAddress.trim()) return null;
  const check = validateDestinationAddress(s.dest, s.pastedAddress);
  return check.ok ? null : check.message;
}

/** A pasted address the user hasn't bridged to before (their own connected wallet never is). */
export function isFirstTimeAddress(s: BridgeFormState): boolean {
  if (s.useConnectedDest) return false;
  const a = s.pastedAddress.trim().toLowerCase();
  return !!a && !s.knownAddresses.includes(a);
}

/** Every input a quote depends on. */
export function quoteKey(s: BridgeFormState): string {
  return [s.source, s.dest, s.amount.trim(), s.speed, s.networkFeeMode, sourceWalletOf(s) ?? "", recipientOf(s)].join("|");
}

/** Whether the inputs are complete enough to ask for a quote. */
export function canRequestQuote(s: BridgeFormState): boolean {
  const n = Number(s.amount);
  return (
    Number.isFinite(n) &&
    n >= MIN_BRIDGE_USDC &&
    !!sourceWalletOf(s) &&
    !!recipientOf(s) &&
    addressError(s) === null
  );
}

/** Why the Bridge button is disabled, or null when it can be pressed. */
export function disableReason(s: BridgeFormState): string | null {
  const n = Number(s.amount);
  if (!s.amount.trim() || !Number.isFinite(n) || n <= 0) return "Enter an amount";
  if (n < MIN_BRIDGE_USDC) return `The minimum is ${MIN_BRIDGE_USDC} USDC`;
  if (!sourceWalletOf(s)) return `Connect your ${label(s.source)} wallet`;
  if (!recipientOf(s)) return `Connect your ${label(s.dest)} wallet or paste an address`;
  if (addressError(s)) return "Check the destination address";
  if (s.quoteError) {
    if (s.quoteError.code === "insufficient_native") {
      return `Not enough ${BRIDGE_CHAINS[s.source].nativeSymbol}`;
    }
    return s.quoteError.message;
  }
  if (!s.quote) return "Getting your price…";
  if (isFirstTimeAddress(s) && !s.firstTimeConfirmed) return "Confirm you've checked this address";
  return null;
}

/** Any input change invalidates the price on screen. */
function cleared(s: BridgeFormState): BridgeFormState {
  return { ...s, quote: null, quoteError: null, notice: null };
}

function swapped(s: BridgeFormState): BridgeFormState {
  // Ruling AD: a pasted address was checked against the old destination
  // chain; it can't follow the swap, so the new To card falls back to the
  // connected wallet.
  return cleared({
    ...s,
    source: s.dest,
    dest: s.source,
    pastedAddress: "",
    useConnectedDest: true,
    firstTimeConfirmed: false,
    networkFeeMode: "usdc",
  });
}

export function bridgeFormReducer(s: BridgeFormState, a: BridgeFormAction): BridgeFormState {
  switch (a.type) {
    case "setSource":
      if (a.chain === s.source) return s;
      if (a.chain === s.dest) return swapped(s);
      return cleared({ ...s, source: a.chain, networkFeeMode: "usdc" });
    case "setDest":
      if (a.chain === s.dest) return s;
      if (a.chain === s.source) return swapped(s);
      return cleared({ ...s, dest: a.chain, pastedAddress: "", useConnectedDest: true, firstTimeConfirmed: false });
    case "swap":
      return swapped(s);
    case "setAmount":
      return cleared({ ...s, amount: a.amount });
    case "setSpeed":
      return cleared({ ...s, speed: a.speed });
    case "setNetworkFeeMode":
      return cleared({ ...s, networkFeeMode: a.mode });
    case "setPastedAddress":
      return cleared({ ...s, pastedAddress: a.address, useConnectedDest: false, firstTimeConfirmed: false });
    case "useConnectedDest":
      return cleared({ ...s, pastedAddress: "", useConnectedDest: true, firstTimeConfirmed: false });
    case "walletsChanged": {
      const next = { ...s, wallets: a.wallets };
      return quoteKey(next) === quoteKey(s) ? next : cleared(next);
    }
    case "knownAddressesLoaded":
      return { ...s, knownAddresses: a.addresses.map((x) => x.toLowerCase()) };
    case "quoteLoaded":
      if (a.key !== quoteKey(s)) return s;
      return { ...s, quote: a.quote, quoteError: null };
    case "quoteFailed":
      if (a.key !== quoteKey(s)) return s;
      if (a.code === "fast_unavailable") {
        return { ...cleared({ ...s, speed: "standard" }), notice: "Fast isn't available for this route right now" };
      }
      return { ...s, quote: null, quoteError: { code: a.code, message: a.message } };
    case "confirmFirstTime":
      return { ...s, firstTimeConfirmed: true };
  }
}
