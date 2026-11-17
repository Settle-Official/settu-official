import test from "node:test";
import assert from "node:assert/strict";

import {
  bridgeFormReducer,
  disableReason,
  addressError,
  initialBridgeForm,
  quoteKey,
  recipientOf,
  type BridgeFormState,
  type LoadedQuote,
} from "./form-state";

const SOL_USER = "7SWdeT5NiwDtbhEmZom9ZmbYWFE5vdsjwqHzgHF3jfyf";
const EVM_USER = "0xa894a3B6fBf182D2D24Fff808B81De849cF7B41c";
const EVM_OTHER = "0x7EF9BC8B9cea37b8236Ce85EcD63fa32e753df94";

function base(over: Partial<BridgeFormState> = {}): BridgeFormState {
  return { ...initialBridgeForm("solana", "base"), ...over };
}

function withWallets(s: BridgeFormState): BridgeFormState {
  return bridgeFormReducer(s, { type: "walletsChanged", wallets: { solana: SOL_USER, evm: EVM_USER } });
}

const FAKE_QUOTE = { breakdown: { receiveAtomic: "98770000" } } as unknown as LoadedQuote;

function ready(): BridgeFormState {
  let s = withWallets(base());
  s = bridgeFormReducer(s, { type: "setAmount", amount: "100" });
  s = bridgeFormReducer(s, { type: "quoteLoaded", key: quoteKey(s), quote: FAKE_QUOTE });
  return s;
}

test("swap swaps source and dest, so each card shows the other's wallet", () => {
  const s = withWallets(base());
  const next = bridgeFormReducer(s, { type: "swap" });
  assert.equal(next.source, "base");
  assert.equal(next.dest, "solana");
  assert.equal(recipientOf(next), SOL_USER);
});

test("swap drops a pasted address: it was for the other chain (Ruling AD)", () => {
  let s = withWallets(base());
  s = bridgeFormReducer(s, { type: "setPastedAddress", address: EVM_OTHER });
  const next = bridgeFormReducer(s, { type: "swap" });
  assert.equal(next.pastedAddress, "");
  assert.equal(next.useConnectedDest, true);
});

test("setDest to the current source swaps", () => {
  const next = bridgeFormReducer(base(), { type: "setDest", chain: "solana" });
  assert.equal(next.source, "base");
  assert.equal(next.dest, "solana");
});

test("setSource to the current dest swaps", () => {
  const next = bridgeFormReducer(base(), { type: "setSource", chain: "base" });
  assert.equal(next.source, "base");
  assert.equal(next.dest, "solana");
});

test("a pasted address that fails validation blocks with its message exposed", () => {
  let s = withWallets(base());
  s = bridgeFormReducer(s, { type: "setAmount", amount: "100" });
  s = bridgeFormReducer(s, { type: "setPastedAddress", address: SOL_USER }); // Solana address on Base
  assert.equal(disableReason(s), "Check the destination address");
  assert.ok(addressError(s));
});

test("a first-time valid address blocks until confirmFirstTime", () => {
  let s = withWallets(base());
  s = bridgeFormReducer(s, { type: "setAmount", amount: "100" });
  s = bridgeFormReducer(s, { type: "setPastedAddress", address: EVM_OTHER });
  s = bridgeFormReducer(s, { type: "quoteLoaded", key: quoteKey(s), quote: FAKE_QUOTE });
  assert.equal(disableReason(s), "Confirm you've checked this address");
  s = bridgeFormReducer(s, { type: "confirmFirstTime" });
  assert.equal(disableReason(s), null);
});

test("a known pasted address doesn't need confirming", () => {
  let s = withWallets(base());
  s = bridgeFormReducer(s, { type: "knownAddressesLoaded", addresses: [EVM_OTHER.toLowerCase()] });
  s = bridgeFormReducer(s, { type: "setAmount", amount: "100" });
  s = bridgeFormReducer(s, { type: "setPastedAddress", address: EVM_OTHER });
  s = bridgeFormReducer(s, { type: "quoteLoaded", key: quoteKey(s), quote: FAKE_QUOTE });
  assert.equal(disableReason(s), null);
});

test("an amount change clears the quote", () => {
  const next = bridgeFormReducer(ready(), { type: "setAmount", amount: "50" });
  assert.equal(next.quote, null);
});

test("a network-fee-mode change clears the quote", () => {
  const next = bridgeFormReducer(ready(), { type: "setNetworkFeeMode", mode: "native" });
  assert.equal(next.quote, null);
  assert.equal(next.networkFeeMode, "native");
});

test("insufficient_native says 'Not enough {native}' and keeps the mode selectable", () => {
  let s = withWallets(base());
  s = bridgeFormReducer(s, { type: "setAmount", amount: "100" });
  s = bridgeFormReducer(s, { type: "setNetworkFeeMode", mode: "native" });
  s = bridgeFormReducer(s, { type: "quoteFailed", key: quoteKey(s), code: "insufficient_native", message: "x" });
  assert.equal(disableReason(s), "Not enough SOL");
  const back = bridgeFormReducer(s, { type: "setNetworkFeeMode", mode: "usdc" });
  assert.equal(back.networkFeeMode, "usdc");
  assert.equal(back.quoteError, null);
});

test("fast_unavailable switches to standard with a notice", () => {
  let s = withWallets(base());
  s = bridgeFormReducer(s, { type: "setAmount", amount: "100" });
  assert.equal(s.speed, "fast");
  s = bridgeFormReducer(s, { type: "quoteFailed", key: quoteKey(s), code: "fast_unavailable", message: "x" });
  assert.equal(s.speed, "standard");
  assert.equal(s.notice, "Fast isn't available for this route right now");
});

test("a stale quote response (inputs changed since) is ignored", () => {
  let s = withWallets(base());
  s = bridgeFormReducer(s, { type: "setAmount", amount: "100" });
  const oldKey = quoteKey(s);
  s = bridgeFormReducer(s, { type: "setAmount", amount: "200" });
  s = bridgeFormReducer(s, { type: "quoteLoaded", key: oldKey, quote: FAKE_QUOTE });
  assert.equal(s.quote, null);
});

test("disable reasons come in order: amount, minimum, wallet, destination, price", () => {
  let s = base();
  assert.equal(disableReason(s), "Enter an amount");
  s = bridgeFormReducer(s, { type: "setAmount", amount: "0.5" });
  assert.equal(disableReason(s), "The minimum is 1 USDC");
  s = bridgeFormReducer(s, { type: "setAmount", amount: "100" });
  assert.equal(disableReason(s), "Connect your Solana wallet");
  s = bridgeFormReducer(s, { type: "walletsChanged", wallets: { solana: SOL_USER } });
  assert.equal(disableReason(s), "Connect your Base wallet or paste an address");
  s = bridgeFormReducer(s, { type: "walletsChanged", wallets: { solana: SOL_USER, evm: EVM_USER } });
  assert.equal(disableReason(s), "Getting your price…");
  s = bridgeFormReducer(s, { type: "quoteLoaded", key: quoteKey(s), quote: FAKE_QUOTE });
  assert.equal(disableReason(s), null);
});

test("an address error from the live check is shown as the reason", () => {
  let s = withWallets(base());
  s = bridgeFormReducer(s, { type: "setAmount", amount: "100" });
  s = bridgeFormReducer(s, {
    type: "quoteFailed",
    key: quoteKey(s),
    code: "token_account",
    message: "That's a token account. Paste the wallet address instead.",
  });
  assert.equal(disableReason(s), "That's a token account. Paste the wallet address instead.");
});
