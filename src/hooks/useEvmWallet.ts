"use client";

import { useState, useCallback, useRef } from "react";
import {
  proposeEvmSession,
  disconnectEvmSession,
  requestChainSwitch,
  sendTransaction,
} from "@/lib/evm/walletconnect-adapter";

export function useEvmWallet() {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [pairingUri, setPairingUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every connect start and on cancel — a stale attempt's late
  // resolve/reject (sign-client gives us no abort) is ignored if it isn't the
  // current one.
  const attemptRef = useRef(0);

  const connect = useCallback(async () => {
    const attempt = ++attemptRef.current;
    setIsConnecting(true);
    setError(null);
    setPairingUri(null);
    try {
      const session = await proposeEvmSession((uri) => {
        if (attemptRef.current === attempt) setPairingUri(uri);
      });
      if (attemptRef.current !== attempt) {
        // Cancelled while we were waiting — drop this session rather than
        // silently connecting after the user backed out.
        void disconnectEvmSession(session.topic).catch(() => {});
        return;
      }
      setAddress(session.address);
      setTopic(session.topic);
    } catch (err: any) {
      if (attemptRef.current === attempt) {
        setError(err?.message || "Failed to connect wallet");
        throw err;
      }
      // Stale attempt (user cancelled) — swallow.
    } finally {
      if (attemptRef.current === attempt) {
        setIsConnecting(false);
        setPairingUri(null);
      }
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      if (topic) await disconnectEvmSession(topic);
    } finally {
      setAddress(null);
      setTopic(null);
      setError(null);
    }
  }, [topic]);

  /** Dismiss the pairing UI without connecting. */
  const cancelConnect = useCallback(() => {
    attemptRef.current++;
    setPairingUri(null);
    setIsConnecting(false);
  }, []);

  const switchChain = useCallback(
    async (chainId: number) => {
      if (!topic) throw new Error("No wallet connected");
      await requestChainSwitch(topic, chainId);
    },
    [topic],
  );

  const signAndSendCalls = useCallback(
    async (calls: { to: `0x${string}`; data: `0x${string}` }[], chainId: number) => {
      if (!topic || !address) throw new Error("No wallet connected");
      const hashes: string[] = [];
      for (const call of calls) {
        hashes.push(await sendTransaction(topic, chainId, address, call));
      }
      return hashes;
    },
    [topic, address],
  );

  return {
    address,
    isConnected: !!address,
    isConnecting,
    pairingUri,
    error,
    connect,
    disconnect,
    cancelConnect,
    switchChain,
    signAndSendCalls,
  };
}
