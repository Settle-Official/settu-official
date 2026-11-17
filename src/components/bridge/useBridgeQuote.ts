"use client";

import { useEffect, type Dispatch } from "react";
import {
  canRequestQuote,
  quoteKey,
  recipientOf,
  sourceWalletOf,
  type BridgeFormAction,
  type BridgeFormState,
} from "@/lib/bridge/form-state";

const DEBOUNCE_MS = 400;
/** Fetch a fresh quote this long before the current one expires. */
const REFRESH_BEFORE_EXPIRY_MS = 15_000;

async function fetchQuote(state: BridgeFormState, dispatch: Dispatch<BridgeFormAction>) {
  const key = quoteKey(state);
  try {
    const res = await fetch("/api/bridge/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: state.source,
        dest: state.dest,
        amount: state.amount.trim(),
        speed: state.speed,
        user: sourceWalletOf(state),
        recipient: recipientOf(state),
        networkFeeMode: state.networkFeeMode,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.quote) {
      dispatch({ type: "quoteLoaded", key, quote: body });
    } else {
      dispatch({
        type: "quoteFailed",
        key,
        code: typeof body?.code === "string" ? body.code : "unavailable",
        message: typeof body?.error === "string" ? body.error : "We couldn't get a price right now. Try again in a moment.",
      });
    }
  } catch {
    dispatch({
      type: "quoteFailed",
      key,
      code: "network",
      message: "We couldn't reach Settu. Check your connection and try again.",
    });
  }
}

/**
 * Keeps the form's quote current: fetches 400 ms after the inputs settle,
 * and again 15 s before the quote on screen expires. Responses for inputs
 * that have since changed are dropped by the reducer (quoteKey).
 */
export function useBridgeQuote(state: BridgeFormState, dispatch: Dispatch<BridgeFormAction>) {
  const key = quoteKey(state);
  const ready = canRequestQuote(state);
  const hasPrice = !!state.quote || !!state.quoteError;

  useEffect(() => {
    if (!ready || hasPrice) return;
    const t = setTimeout(() => void fetchQuote(state, dispatch), DEBOUNCE_MS);
    return () => clearTimeout(t);
    // `state` is read at fire time; the key captures every input it uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready, hasPrice, dispatch]);

  const expiresAt = state.quote?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const wait = Math.max(0, expiresAt * 1000 - Date.now() - REFRESH_BEFORE_EXPIRY_MS);
    const t = setTimeout(() => void fetchQuote(state, dispatch), wait);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt, key, dispatch]);
}
