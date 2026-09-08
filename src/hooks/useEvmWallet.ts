"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  proposeEvmSession,
  disconnectEvmSession,
  requestChainSwitch,
  sendTransaction,
} from "@/lib/evm/walletconnect-adapter";
import {
  discoverInjectedWallets,
  toChainIdHex,
  type Eip1193Provider,
  type InjectedWallet,
} from "@/lib/evm/injected";

type EvmTransport = "injected" | "walletconnect";

/**
 * One EVM wallet, connected either through a desktop browser extension
 * (EIP-6963 injected provider — direct, no relay) or WalletConnect (QR, for
 * mobile wallets). Callers don't care which: address / switchChain /
 * signAndSendCalls behave identically. Parallel to and independent from the
 * Stellar Wallets Kit path — only one of the two is ever connected at once.
 */
export function useEvmWallet() {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [transport, setTransport] = useState<EvmTransport | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false);
  const [injectedWallets, setInjectedWallets] = useState<InjectedWallet[]>([]);
  const [pairingUri, setPairingUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const topicRef = useRef<string | null>(null);
  const injectedRef = useRef<Eip1193Provider | null>(null);
  // Bumped on every connect start / cancel — a stale WalletConnect attempt
  // that resolves late (sign-client has no abort) is then ignored.
  const attemptRef = useRef(0);

  const clearConnection = useCallback(() => {
    setAddress(null);
    setTransport(null);
    topicRef.current = null;
    injectedRef.current = null;
  }, []);

  // --- injected (EIP-1193) account/chain change handling -------------------
  useEffect(() => {
    const provider = injectedRef.current;
    if (transport !== "injected" || !provider) return;

    const onAccountsChanged = (accounts: string[]) => {
      if (!accounts || accounts.length === 0) {
        clearConnection();
      } else {
        setAddress(accounts[0] as `0x${string}`);
      }
    };
    provider.on("accountsChanged", onAccountsChanged);
    return () => provider.removeListener("accountsChanged", onAccountsChanged);
  }, [transport, address, clearConnection]);

  // --- opening / closing the connect picker -------------------------------
  const openConnect = useCallback(async () => {
    setError(null);
    setIsConnectModalOpen(true);
    setInjectedWallets(await discoverInjectedWallets());
  }, []);

  const closeConnect = useCallback(() => {
    attemptRef.current++;
    setIsConnectModalOpen(false);
    setIsConnecting(false);
    setPairingUri(null);
  }, []);

  // --- connect via an installed browser extension -------------------------
  const connectInjected = useCallback(
    async (rdns: string) => {
      const wallet = injectedWallets.find((w) => w.info.rdns === rdns);
      if (!wallet) {
        setError("That wallet is no longer available.");
        return;
      }
      setIsConnecting(true);
      setError(null);
      console.log("[useEvmWallet] connecting via injected:", rdns);
      try {
        // Some wallets never resolve/reject eth_requestAccounts if their popup
        // is suppressed (locked extension, already-open request). Time out so
        // the UI can tell the user to open the extension manually.
        const accountsPromise = wallet.provider.request({
          method: "eth_requestAccounts",
        }) as Promise<string[]>;
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "No response from your wallet. Open the extension from your toolbar (unlock it if needed) and approve the connection, then try again.",
                ),
              ),
            60_000,
          ),
        );
        const accounts = await Promise.race([accountsPromise, timeout]);
        console.log("[useEvmWallet] eth_requestAccounts ->", accounts);
        if (!accounts || accounts.length === 0) {
          throw new Error("Wallet returned no account");
        }
        injectedRef.current = wallet.provider;
        setAddress(accounts[0] as `0x${string}`);
        setTransport("injected");
        setIsConnectModalOpen(false);
      } catch (err: any) {
        const msg = err?.message || "Failed to connect wallet";
        console.error("[useEvmWallet] injected connect failed:", err);
        setError(msg);
        if (!/reject|denied|cancel|4001/i.test(msg)) throw err;
      } finally {
        setIsConnecting(false);
      }
    },
    [injectedWallets],
  );

  // --- connect via WalletConnect (QR for mobile wallets) -----------------
  const connectWalletConnect = useCallback(async () => {
    const attempt = ++attemptRef.current;
    setIsConnecting(true);
    setError(null);
    setPairingUri(null);
    try {
      const session = await proposeEvmSession((uri) => {
        if (attemptRef.current === attempt) setPairingUri(uri);
      });
      if (attemptRef.current !== attempt) {
        void disconnectEvmSession(session.topic).catch(() => {});
        return;
      }
      topicRef.current = session.topic;
      setAddress(session.address);
      setTransport("walletconnect");
      setIsConnectModalOpen(false);
    } catch (err: any) {
      if (attemptRef.current === attempt) {
        setError(err?.message || "Failed to connect wallet");
        throw err;
      }
    } finally {
      if (attemptRef.current === attempt) {
        setIsConnecting(false);
        setPairingUri(null);
      }
    }
  }, []);

  const disconnect = useCallback(async () => {
    attemptRef.current++;
    try {
      if (transport === "walletconnect" && topicRef.current) {
        await disconnectEvmSession(topicRef.current);
      }
    } finally {
      clearConnection();
      setError(null);
    }
  }, [transport, clearConnection]);

  const switchChain = useCallback(
    async (chainId: number) => {
      if (transport === "injected" && injectedRef.current) {
        try {
          await injectedRef.current.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: toChainIdHex(chainId) }],
          });
        } catch (err: any) {
          if (err?.code === 4902) {
            throw new Error(
              "That network isn't in your wallet yet — add it and try again.",
            );
          }
          throw err;
        }
        return;
      }
      if (transport === "walletconnect" && topicRef.current) {
        await requestChainSwitch(topicRef.current, chainId);
        return;
      }
      throw new Error("No wallet connected");
    },
    [transport],
  );

  const signAndSendCalls = useCallback(
    async (
      calls: { to: `0x${string}`; data: `0x${string}` }[],
      chainId: number,
    ) => {
      if (!address) throw new Error("No wallet connected");
      const hashes: string[] = [];

      if (transport === "injected" && injectedRef.current) {
        for (const call of calls) {
          const hash = (await injectedRef.current.request({
            method: "eth_sendTransaction",
            params: [{ from: address, to: call.to, data: call.data }],
          })) as string;
          hashes.push(hash);
        }
        return hashes;
      }

      if (transport === "walletconnect" && topicRef.current) {
        for (const call of calls) {
          hashes.push(
            await sendTransaction(topicRef.current, chainId, address, call),
          );
        }
        return hashes;
      }

      throw new Error("No wallet connected");
    },
    [address, transport],
  );

  return {
    address,
    isConnected: !!address,
    transport,
    isConnecting,
    isConnectModalOpen,
    injectedWallets,
    pairingUri,
    error,
    openConnect,
    closeConnect,
    connectInjected,
    connectWalletConnect,
    disconnect,
    switchChain,
    signAndSendCalls,
  };
}
