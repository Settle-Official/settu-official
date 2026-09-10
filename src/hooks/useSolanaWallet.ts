"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { VersionedTransaction, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  subscribeSolanaWallets,
  accountSolanaChain,
  StandardConnect,
  StandardDisconnect,
  SolanaSignAndSendTransaction,
  type SolanaWalletEntry,
  SolanaSignMessage,
} from "@/lib/solana/wallet-standard";

/**
 * One Solana wallet (Phantom / Solflare / Backpack …) via Wallet Standard.
 * Same shape family as `useEvmWallet` / `useStellarWallet`. No chain-switch.
 * `signAndSendBurn` takes the base64 unsigned tx from `solana-build-tx` plus
 * the ephemeral MessageSent event keypair: it partial-signs with that
 * keypair, then the wallet signs + sends.
 */
export function useSolanaWallet() {
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [detectedWallets, setDetectedWallets] = useState<SolanaWalletEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const walletRef = useRef<Wallet | null>(null);
  const accountRef = useRef<WalletAccount | null>(null);

  useEffect(() => subscribeSolanaWallets(setDetectedWallets), []);

  const clear = useCallback(() => {
    walletRef.current = null;
    accountRef.current = null;
    setAddress(null);
  }, []);

  const connect = useCallback(
    async (walletName: string) => {
      const entry = detectedWallets.find((w) => w.name === walletName);
      if (!entry) {
        setError("That wallet is no longer available.");
        return;
      }
      setIsConnecting(true);
      setError(null);
      try {
        const feature = (entry.wallet.features as any)[StandardConnect];
        const { accounts } = await feature.connect();
        const account: WalletAccount | undefined =
          accounts?.[0] ?? entry.wallet.accounts?.[0];
        if (!account) throw new Error("Wallet returned no account");
        walletRef.current = entry.wallet;
        accountRef.current = account;
        setAddress(account.address);
      } catch (err: any) {
        const msg = err?.message || "Failed to connect wallet";
        setError(msg);
        if (!/reject|denied|cancel|user/i.test(msg)) throw err;
      } finally {
        setIsConnecting(false);
      }
    },
    [detectedWallets],
  );

  const disconnect = useCallback(async () => {
    const wallet = walletRef.current;
    try {
      const feature = wallet && (wallet.features as any)[StandardDisconnect];
      if (feature) await feature.disconnect();
    } finally {
      clear();
      setError(null);
    }
  }, [clear]);

  // Proves control of the address for wallet linking. Solana signs raw message
  // bytes, so the backend verifies it as a plain ed25519 signature.
  const signMessage = useCallback(async (message: string): Promise<string> => {
    const wallet = walletRef.current;
    const account = accountRef.current;
    if (!wallet || !account) throw new Error("No Solana wallet connected");

    const feature = (wallet.features as any)[SolanaSignMessage];
    if (!feature) {
      throw new Error(`${wallet.name} can't sign messages — try another wallet.`);
    }

    const [{ signature }] = await feature.signMessage({
      account,
      message: new TextEncoder().encode(message),
    });
    return bs58.encode(signature);
  }, []);

  const signAndSendBurn = useCallback(
    async (transactionBase64: string, eventKeypair: Keypair): Promise<string> => {
      const wallet = walletRef.current;
      const account = accountRef.current;
      if (!wallet || !account) throw new Error("No Solana wallet connected");

      const feature = (wallet.features as any)[SolanaSignAndSendTransaction];
      if (!feature) {
        throw new Error(
          `${wallet.name} can't sign and send transactions — try another wallet.`,
        );
      }

      const tx = VersionedTransaction.deserialize(
        Uint8Array.from(Buffer.from(transactionBase64, "base64")),
      );
      // Add the ephemeral MessageSent event account's signature first; the
      // wallet fills the payer/owner slot and broadcasts.
      tx.sign([eventKeypair]);

      const [{ signature }] = await feature.signAndSendTransaction({
        account,
        transaction: tx.serialize(),
        chain: accountSolanaChain(account),
      });
      return bs58.encode(signature);
    },
    [],
  );

  return {
    address,
    isConnected: !!address,
    isConnecting,
    detectedWallets,
    error,
    connect,
    disconnect,
    signAndSendBurn,
    signMessage,
  };
}
