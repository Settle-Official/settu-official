"use client";

import type { SolanaWalletEntry } from "@/lib/solana/wallet-standard";

interface SolanaConnectModalProps {
  readonly open: boolean;
  readonly wallets: SolanaWalletEntry[];
  readonly isConnecting: boolean;
  readonly error: string | null;
  readonly onPick: (walletName: string) => void;
  readonly onClose: () => void;
}

/**
 * Solana wallet picker (Wallet Standard — Phantom / Solflare / Backpack …).
 * The Solana sibling of EvmConnectModal; kept separate rather than merged
 * because the two have no transport overlap.
 */
export function SolanaConnectModal({
  open,
  wallets,
  isConnecting,
  error,
  onPick,
  onClose,
}: Readonly<SolanaConnectModalProps>) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-[92vw] max-w-[400px] border border-[var(--line)] bg-[#0c0c0c] p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="m-0 font-space-grotesk text-[1.05rem] font-bold tracking-[-0.02em]">
            CONNECT SOLANA WALLET
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[1.1rem] leading-none text-[var(--muted)] hover:text-white"
          >
            ✕
          </button>
        </div>

        {error && <p className="mt-0 mb-3 text-[0.72rem] text-red-400">{error}</p>}
        {isConnecting && !error && (
          <p className="mt-0 mb-3 text-[0.72rem] text-[var(--accent)]">
            Check your wallet — approve the connection request…
          </p>
        )}

        <div className="flex flex-col gap-2">
          {wallets.length === 0 && (
            <p className="mt-0 mb-1 text-[0.72rem] text-[var(--muted)]">
              No Solana wallet detected. Install Phantom, Solflare or Backpack.
            </p>
          )}
          {wallets.map((w) => (
            <button
              key={w.name}
              type="button"
              disabled={isConnecting}
              onClick={() => onPick(w.name)}
              className="flex h-11 items-center gap-3 border border-[var(--line)] px-3 text-left text-[0.85rem] hover:border-[#666] disabled:opacity-40"
            >
              {w.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={w.icon} alt="" className="h-5 w-5" />
              ) : (
                <span className="h-5 w-5 shrink-0 rounded-sm bg-[#2a2a2a]" />
              )}
              <span className="font-bold">{w.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
