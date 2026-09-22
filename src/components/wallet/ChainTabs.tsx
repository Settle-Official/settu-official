"use client";

import { useEffect, useState } from "react";
import { shortAddress } from "@/lib/api/wallets";
import { EVM_SOURCE_CHAINS, type EvmChainKey } from "@/lib/cctp/evm-chains";

export type WalletChain = "stellar" | "evm" | "solana";

export const CHAIN_LABEL: Record<WalletChain, string> = {
  stellar: "STELLAR",
  evm: "ETH",
  solana: "SOLANA",
};

// One EVM address works on every chain we support, so the network is a view
// over the same wallet rather than a different one.
const EVM_NETWORKS = Object.keys(EVM_SOURCE_CHAINS) as EvmChainKey[];

interface Balance {
  code: string;
  amount: string;
}

/** Trims Stellar's seven decimals to something readable without hiding dust. */
function format(amount: string): string {
  const value = Number(amount);
  if (value === 0) return "0.00";
  return value < 1 ? value.toFixed(6).replace(/0+$/, "") : value.toFixed(2);
}

export function ChainTabs({
  addresses,
  onAdd,
}: {
  readonly addresses: Partial<Record<WalletChain, string>>;
  readonly onAdd: (chain: WalletChain) => void;
}) {
  const [active, setActive] = useState<WalletChain>("stellar");
  const [network, setNetwork] = useState<EvmChainKey>("base");
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [copied, setCopied] = useState(false);

  const address = addresses[active];

  useEffect(() => {
    if (!address) {
      setBalances(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      fetch(
        `/api/wallet/balances?chain=${active}&address=${address}&network=${network}`,
      )
        .then((res) => res.json())
        .then((data) => !cancelled && setBalances(data.balances ?? []))
        .catch(() => {});

    setBalances(null);
    load();
    const timer = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, address, network]);

  return (
    <div className="flex flex-col gap-[0.9rem]">
      <div className="flex gap-2">
        {(Object.keys(CHAIN_LABEL) as WalletChain[]).map((chain) => {
          const isActive = chain === active;
          return (
            <button
              key={chain}
              type="button"
              onClick={() => setActive(chain)}
              style={
                isActive
                  ? { borderColor: "var(--accent)", color: "var(--accent)" }
                  : undefined
              }
              className={`flex-1 border py-2 text-[0.7rem] uppercase tracking-[0.08em] ${
                isActive
                  ? ""
                  : "border-[var(--line)] text-[var(--muted)]"
              }`}
            >
              {CHAIN_LABEL[chain]}
            </button>
          );
        })}
      </div>

      {address ? (
        <>
          <div className="flex items-center gap-2">
            <p className="m-0 font-mono text-[0.85rem]">
              {shortAddress(address)}
            </p>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              aria-label={copied ? "Address copied" : "Copy address"}
              title={copied ? "Copied" : "Copy address"}
              className="text-[var(--muted)] transition-colors hover:text-[var(--accent)]"
            >
              {copied ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="11" height="11" rx="1" />
                  <path d="M5 15V5a1 1 0 011-1h10" />
                </svg>
              )}
            </button>
          </div>

          {active === "evm" && (
            <div className="flex flex-wrap gap-[0.35rem]">
              {EVM_NETWORKS.map((key) => {
                const selected = key === network;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setNetwork(key)}
                    style={
                      selected
                        ? { borderColor: "var(--accent)", color: "var(--accent)" }
                        : undefined
                    }
                    className={`border px-2 py-[0.2rem] text-[0.62rem] uppercase tracking-[0.06em] ${
                      selected ? "" : "border-[var(--line)] text-[var(--muted)]"
                    }`}
                  >
                    {EVM_SOURCE_CHAINS[key].label}
                  </button>
                );
              })}
            </div>
          )}

          {balances === null ? (
            <p className="m-0 text-[0.72rem] text-[var(--muted)]">
              Loading balances…
            </p>
          ) : (
            <div className="flex flex-col gap-[0.35rem]">
              {balances.map((balance) => (
                <div
                  key={balance.code}
                  className="flex items-baseline justify-between border border-[var(--line)] px-3 py-2"
                >
                  <span className="text-[0.72rem] tracking-[0.08em] text-[var(--muted)]">
                    {balance.code}
                  </span>
                  <span className="font-mono text-[0.95rem]">
                    {format(balance.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <button
          type="button"
          onClick={() => onAdd(active)}
          className="h-10 border border-[var(--line)] text-[0.72rem] uppercase tracking-[0.08em] text-[var(--muted)]"
        >
          Add {CHAIN_LABEL[active]} wallet
        </button>
      )}
    </div>
  );
}
