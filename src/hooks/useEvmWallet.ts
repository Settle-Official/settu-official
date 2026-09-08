"use client";

import { useState, useCallback } from "react";
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

  const connect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    setPairingUri(null);
    try {
      const session = await proposeEvmSession((uri) => setPairingUri(uri));
      setAddress(session.address);
      setTopic(session.topic);
    } catch (err: any) {
      setError(err?.message || "Failed to connect wallet");
      throw err;
    } finally {
      setIsConnecting(false);
      setPairingUri(null);
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
    switchChain,
    signAndSendCalls,
  };
}
