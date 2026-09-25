"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { VersionedTransaction, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  connectSolana,
  disconnectSolana,
  getSolanaAddress,
  getSolanaProvider,
  subscribeSolanaAccount,
} from "@/lib/wallet/appkit";

// AppKit's own record of which chains are connected (SafeLocalStorageKeys
// .CONNECTED_NAMESPACES in @reown/appkit-common), read without loading AppKit.
function hasStoredSolanaConnection(): boolean {
  try {
    return (window.localStorage.getItem("@appkit/connected_namespaces") ?? "")
      .split(",")
      .includes("solana");
  } catch {
    return false;
  }
}

/**
 * One Solana wallet, via Reown AppKit.
 *
 * Previously this used Wallet Standard directly, which only ever registers
 * browser extensions — so mobile had no way to connect at all. AppKit lists
 * wallets from the WalletConnect registry and deep-links into them on mobile,
 * matching how Stellar and EVM already connect here. Signing therefore goes
 * through AppKit's provider rather than Wallet Standard's features.
 */
export function useSolanaWallet() {
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow connects/disconnects made inside AppKit's own UI, which this hook
  // never sees otherwise. Idempotent: the restore path and connect() both
  // call it.
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const unmountedRef = useRef(false);
  const follow = useCallback(async () => {
    if (unsubscribeRef.current) return;
    const unsubscribe = await subscribeSolanaAccount((next) => {
      if (!unmountedRef.current) setAddress(next);
    });
    if (unmountedRef.current || unsubscribeRef.current) unsubscribe();
    else unsubscribeRef.current = unsubscribe;
  }, []);

  // Restore an existing connection. This hook is mounted app-wide, and
  // starting AppKit is a large download plus a relay connection, so only do
  // it when AppKit recorded a Solana connection; otherwise it waits for a
  // connect click.
  useEffect(() => {
    unmountedRef.current = false;
    if (hasStoredSolanaConnection()) {
      (async () => {
        const existing = await getSolanaAddress();
        if (!unmountedRef.current && existing) setAddress(existing);
        await follow();
      })().catch(() => {
        // AppKit failed to initialise; connect() surfaces the real error on click.
      });
    }

    return () => {
      unmountedRef.current = true;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [follow]);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    try {
      const connected = await connectSolana();
      setAddress(connected);
      void follow().catch(() => {});
      return connected;
    } catch (err: any) {
      const message = err?.message || "Failed to connect wallet";
      // Dismissing the sheet is a normal action, not an error worth showing.
      if (!/reject|denied|cancel|closed|dismiss/i.test(message)) {
        setError(message);
        throw err;
      }
      return null;
    } finally {
      setIsConnecting(false);
    }
  }, [follow]);

  const disconnect = useCallback(async () => {
    try {
      await disconnectSolana();
    } finally {
      setAddress(null);
      setError(null);
    }
  }, []);

  const signAndSendBurn = useCallback(
    async (transactionBase64: string, eventKeypair: Keypair): Promise<string> => {
      const provider = await getSolanaProvider();

      const tx = VersionedTransaction.deserialize(
        Uint8Array.from(Buffer.from(transactionBase64, "base64")),
      );
      // The ephemeral MessageSent event account signs first; the wallet fills
      // the payer/owner slot and broadcasts.
      tx.sign([eventKeypair]);

      // Already a base58 signature string.
      return provider.signAndSendTransaction(tx);
    },
    [],
  );

  // Proves control of the address for wallet linking.
  const signMessage = useCallback(async (message: string): Promise<string> => {
    const provider = await getSolanaProvider();
    // Declared as Uint8Array, but some wallets return a base58 string — the
    // mismatch that broke the burn path, so tolerate both here.
    const signature: unknown = await provider.signMessage(
      new TextEncoder().encode(message),
    );
    return typeof signature === "string"
      ? signature
      : bs58.encode(signature as Uint8Array);
  }, []);

  return {
    address,
    isConnected: !!address,
    isConnecting,
    error,
    connect,
    disconnect,
    signAndSendBurn,
    signMessage,
  };
}
