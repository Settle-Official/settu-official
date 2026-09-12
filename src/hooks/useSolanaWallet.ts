"use client";

import { useState, useCallback, useEffect } from "react";
import { VersionedTransaction, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  connectSolana,
  disconnectSolana,
  getSolanaAddress,
  getSolanaProvider,
  subscribeSolanaAccount,
} from "@/lib/solana/appkit";

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

  // Restore an existing connection and follow connects/disconnects made inside
  // AppKit's own UI, which this hook never sees otherwise.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      const existing = await getSolanaAddress();
      if (!cancelled && existing) setAddress(existing);
      unsubscribe = await subscribeSolanaAccount((next) => {
        if (!cancelled) setAddress(next);
      });
    })().catch(() => {
      // AppKit failed to initialise; connect() surfaces the real error on click.
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    try {
      const connected = await connectSolana();
      setAddress(connected);
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
  }, []);

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

      const { signature } = await provider.signAndSendTransaction(tx);
      // Wallets return either a base58 string or raw bytes.
      return typeof signature === "string" ? signature : bs58.encode(signature);
    },
    [],
  );

  // Proves control of the address for wallet linking.
  const signMessage = useCallback(async (message: string): Promise<string> => {
    const provider = await getSolanaProvider();
    const signature = await provider.signMessage(
      new TextEncoder().encode(message),
    );
    return typeof signature === "string" ? signature : bs58.encode(signature);
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
