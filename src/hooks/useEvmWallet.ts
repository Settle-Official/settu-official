"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { isMobileBrowser } from "@/lib/platform";
import {
  proposeEvmSession,
  disconnectEvmSession,
  requestChainSwitch,
  sendTransaction,
  signPersonalMessage,
} from "@/lib/evm/walletconnect-adapter";
import {
  subscribeInjectedWallets,
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
  const refreshInjectedRef = useRef<() => void>(() => {});
  // openConnect is declared before connectWalletConnect, so it reaches it
  // through a ref rather than being reordered.
  const connectWalletConnectRef = useRef<(() => Promise<void>) | null>(null);

  // Discover installed browser wallets (EIP-6963) for the lifetime of the
  // component — they can announce at any time, so we stay subscribed rather
  // than probing once when the modal opens.
  useEffect(() => {
    const { unsubscribe, refresh } = subscribeInjectedWallets(setInjectedWallets);
    refreshInjectedRef.current = refresh;
    return unsubscribe;
  }, []);

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
  // Mobile has no browser extensions, so the in-app picker would only ever
  // offer WalletConnect — an extra tap in front of the sheet that does the
  // work. Skip straight to it, matching how the Stellar side behaves.
  const openConnect = useCallback(async () => {
    setError(null);
    // Returns the connect promise on mobile so the caller can surface a
    // failure — the modal that would normally show `error` never opens there.
    if (isMobileBrowser()) {
      await connectWalletConnectRef.current?.();
      return;
    }
    setIsConnectModalOpen(true);
    // Re-probe in case a wallet loaded after mount.
    refreshInjectedRef.current();
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

  connectWalletConnectRef.current = connectWalletConnect;

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

  // Proves control of the address for wallet linking. personal_sign, not
  // eth_sign: the wallet shows readable text rather than an opaque hash, and
  // the prefix it applies means a signed message can never be a transaction.
  const signMessage = useCallback(
    async (message: string): Promise<string> => {
      if (!address) throw new Error("No wallet connected");

      if (transport === "injected" && injectedRef.current) {
        const hex = `0x${Buffer.from(message, "utf8").toString("hex")}`;
        return (await injectedRef.current.request({
          method: "personal_sign",
          params: [hex, address],
        })) as string;
      }
      if (transport === "walletconnect" && topicRef.current) {
        return signPersonalMessage(topicRef.current, 1, address, message);
      }
      throw new Error("No wallet connected");
    },
    [address, transport],
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
    signMessage,
    signAndSendCalls,
  };
}
