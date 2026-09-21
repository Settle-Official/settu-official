"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  connectWallet,
  restoreWallet,
  disconnectWallet,
  onWalletStateChange,
  hasStoredWalletSession,
  signTransaction as signWithWallet,
  type StellarWallet,
} from "@/lib/stellar/wallet-adapter";
import { isUnlocked as isSettuWalletUnlocked } from "@/lib/stellar/settu-wallet/session";

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

    // An unlocked Settu wallet is a session too, and it leaves no kit storage,
    // so the dashboard would otherwise never see it.
    if (hasStoredWalletSession() || isSettuWalletUnlocked()) {
      (async () => {
        // Subscribe before restoring: the kit emits current state on
        // subscribe, so the other order lets that initial (still empty) event
        // clobber the session we just restored.
        await subscribe();
        const restored = await restoreWallet();
        if (!cancelled && restored) setWallet(restored);
      })().catch(() => {
        // Kit failed to initialize — leave the UI disconnected rather than
        // blocking render; connect() surfaces the real error on click.
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
