"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface WalletBarSnapshot {
  readonly address?: string;
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
}

interface WalletBarHandlers {
  readonly connect: () => void;
  readonly disconnect: () => void;
}

interface WalletBarValue {
  /** Null when no screen has claimed the bar — the shell falls back to Stellar. */
  readonly snapshot: WalletBarSnapshot | null;
  readonly connect: () => void;
  readonly disconnect: () => void;
  readonly publish: (
    snapshot: WalletBarSnapshot | null,
    handlers?: WalletBarHandlers,
  ) => void;
}

const noop = () => {};
const WalletBarContext = createContext<WalletBarValue>({
  snapshot: null,
  connect: noop,
  disconnect: noop,
  publish: noop,
});

const same = (a: WalletBarSnapshot | null, b: WalletBarSnapshot | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.address === b.address &&
    a.isConnected === b.isConnected &&
    a.isConnecting === b.isConnecting);

/**
 * Lets the active screen tell the app shell's top bar which wallet is in
 * play. The offramp/agent screens switch between Stellar, EVM and Solana
 * per source chain, and the bar has to show — and connect — that one, not
 * always Stellar. Handlers live in a ref so republishing them every render
 * can't loop; only the primitives drive re-renders.
 */
export function WalletBarProvider({ children }: { readonly children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<WalletBarSnapshot | null>(null);
  const handlers = useRef<WalletBarHandlers | null>(null);

  const publish = useCallback(
    (next: WalletBarSnapshot | null, nextHandlers?: WalletBarHandlers) => {
      handlers.current = next ? (nextHandlers ?? null) : null;
      setSnapshot((current) => (same(current, next) ? current : next));
    },
    [],
  );

  const value = useMemo<WalletBarValue>(
    () => ({
      snapshot,
      publish,
      connect: () => handlers.current?.connect(),
      disconnect: () => handlers.current?.disconnect(),
    }),
    [snapshot, publish],
  );

  return <WalletBarContext.Provider value={value}>{children}</WalletBarContext.Provider>;
}

export function useWalletBar() {
  return useContext(WalletBarContext);
}
