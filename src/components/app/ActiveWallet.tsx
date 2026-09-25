"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useSolanaWallet } from "@/hooks/useSolanaWallet";
import { useStellarWallet } from "@/hooks/useStellarWallet";
import { EvmConnectModal } from "@/components/EvmConnectModal";
import type { OfframpSourceChainKey } from "@/lib/offramp/source-chain-options";

export interface ActiveWalletView {
  readonly chain: "stellar" | "evm" | "solana";
  readonly address?: string;
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly connect: () => void;
  readonly disconnect: () => void;
}

interface ActiveWalletValue {
  readonly evm: ReturnType<typeof useEvmWallet>;
  readonly solana: ReturnType<typeof useSolanaWallet>;
  /** The offramp's source chain: the wallet the user last chose to pay from. */
  readonly sourceChain: OfframpSourceChainKey;
  readonly setSourceChain: (next: OfframpSourceChainKey) => void;
  /**
   * The wallet screens without their own source chain (dashboard, history,
   * notifications, help) show and read from — see pickActive.
   */
  readonly active: ActiveWalletView;
}

const ActiveWalletContext = createContext<ActiveWalletValue | null>(null);

// Swallowed here: each hook keeps its own `error`, and the EVM modal shows it.
const quietly = (run: () => Promise<unknown> | void) => () => {
  void Promise.resolve()
    .then(run)
    .catch(() => {});
};

/**
 * The EVM and Solana wallets, and the offramp's source chain, for the whole
 * /app shell. They used to live inside each screen, so leaving Offramp dropped
 * an EVM wallet and the sidebar fell back to Stellar everywhere else. One
 * instance here survives navigation, and lets every screen agree on which
 * wallet is in play.
 */
export function ActiveWalletProvider({ children }: { readonly children: ReactNode }) {
  const evm = useEvmWallet();
  const solana = useSolanaWallet();
  const stellar = useStellarWallet();
  const [sourceChain, setSourceChain] = useState<OfframpSourceChainKey>("stellar");

  const active = useMemo<ActiveWalletView>(() => {
    const views: Record<ActiveWalletView["chain"], ActiveWalletView> = {
      stellar: {
        chain: "stellar",
        address: stellar.wallet?.publicKey,
        isConnected: stellar.isConnected,
        isConnecting: stellar.isConnecting,
        connect: quietly(stellar.connect),
        disconnect: quietly(stellar.disconnect),
      },
      evm: {
        chain: "evm",
        address: evm.address ?? undefined,
        isConnected: evm.isConnected,
        isConnecting: evm.isConnecting,
        connect: quietly(evm.openConnect),
        disconnect: quietly(evm.disconnect),
      },
      solana: {
        chain: "solana",
        address: solana.address ?? undefined,
        isConnected: solana.isConnected,
        isConnecting: solana.isConnecting,
        connect: quietly(solana.connect),
        disconnect: quietly(solana.disconnect),
      },
    };
    return pickActive(views, sourceChain);
  }, [stellar, evm, solana, sourceChain]);

  const value = useMemo<ActiveWalletValue>(
    () => ({ evm, solana, sourceChain, setSourceChain, active }),
    [evm, solana, sourceChain, active],
  );

  return (
    <ActiveWalletContext.Provider value={value}>
      {children}
      {/* Lives with the wallet it connects, so the sidebar can open it from
          any screen, not only Offramp. */}
      <EvmConnectModal
        open={evm.isConnectModalOpen}
        injectedWallets={evm.injectedWallets}
        pairingUri={evm.pairingUri}
        isConnecting={evm.isConnecting}
        error={evm.error}
        onPickInjected={(rdns) => quietly(() => evm.connectInjected(rdns))()}
        onPickWalletConnect={quietly(evm.connectWalletConnect)}
        onClose={evm.closeConnect}
      />
    </ActiveWalletContext.Provider>
  );
}

/**
 * Last used wins: the source chain's wallet when it's connected; otherwise
 * whichever wallet is (Stellar first, as the default); otherwise the source
 * chain's, so "Connect" opens the wallet the user last chose.
 */
function pickActive(
  views: Record<ActiveWalletView["chain"], ActiveWalletView>,
  sourceChain: OfframpSourceChainKey,
): ActiveWalletView {
  const preferred =
    sourceChain === "stellar"
      ? views.stellar
      : sourceChain === "solana"
        ? views.solana
        : views.evm;
  if (preferred.isConnected) return preferred;
  const connected = [views.stellar, views.evm, views.solana].find((v) => v.isConnected);
  return connected ?? preferred;
}

export function useActiveWallet(): ActiveWalletValue {
  const value = useContext(ActiveWalletContext);
  if (!value) throw new Error("useActiveWallet must be used inside ActiveWalletProvider");
  return value;
}
