"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  connectWallet,
  restoreWallet,
  disconnectWallet,
  onWalletStateChange,
  hasStoredWalletSession,
  peekStoredWallet,
  signTransaction as signWithWallet,
  type StellarWallet,
} from "@/lib/stellar/wallet-adapter";

export function useStellarWallet() {
  const [wallet, setWallet] = useState<StellarWallet | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Follow kit state so an account switch in the wallet, or a disconnect from
  // the kit's own profile modal, reaches the UI. Idempotent — the restore path
  // and the connect path both call it, whichever happens first.
  const subscribe = useCallback(async () => {
    if (unsubscribeRef.current) return;
    unsubscribeRef.current = await onWalletStateChange((next) =>
      setWallet(next),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Only boot the kit on mount when there's actually a session to restore;
    // otherwise defer it to the Connect click so a first-time visitor doesn't
    // pay to download every wallet module before they've asked for one.
    if (hasStoredWalletSession()) {
      // Show the stored session straight away so navigating between pages
      // (landing → /app) doesn't flash "connect" while the kit's dynamic
      // import loads; the restore below then confirms it, or clears it if
      // the stored session can no longer sign.
      const peeked = peekStoredWallet();
      if (peeked) setWallet(peeked);

      (async () => {
        // Subscribe before restoring: the kit emits current state on
        // subscribe, so the other order lets that initial (still empty) event
        // clobber the session we just restored.
        await subscribe();
        const restored = await restoreWallet();
        if (!cancelled) setWallet(restored);
      })().catch((err) => {
        // Kit failed to initialize — leave the UI disconnected rather than
        // blocking render; connect() surfaces the real error on click.
        console.warn("[wallet] session restore failed", err);
      });
    }

    return () => {
      cancelled = true;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [subscribe]);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    try {
      const connected = await connectWallet();
      setWallet(connected);
      await subscribe();
      return connected;
    } catch (err: any) {
      const message = err?.message || "Failed to connect wallet";
      // Dismissing the sheet is a normal action, not an error to show.
      if (/reject|denied|cancel|closed|dismiss/i.test(message)) return null;
      setError(message);
      throw err;
    } finally {
      setIsConnecting(false);
    }
  }, [subscribe]);

  const disconnect = useCallback(async () => {
    try {
      await disconnectWallet();
    } finally {
      setWallet(null);
      setError(null);
    }
  }, []);

  const signTransaction = useCallback(
    async (xdr: string): Promise<string> => {
      if (!wallet) throw new Error("No wallet connected");
      try {
        return await signWithWallet(xdr, wallet.publicKey);
      } catch (err: any) {
        setError(err?.message || "Failed to sign transaction");
        throw err;
      }
    },
    [wallet],
  );

  return {
    wallet,
    isConnected: !!wallet,
    isConnecting,
    error,
    connect,
    disconnect,
    signTransaction,
  };
}
