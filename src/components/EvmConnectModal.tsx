"use client";

import { useEffect, useState } from "react";
import type { InjectedWallet } from "@/lib/evm/injected";

interface EvmConnectModalProps {
  readonly open: boolean;
  readonly injectedWallets: InjectedWallet[];
  readonly pairingUri: string | null;
  readonly isConnecting: boolean;
  readonly error: string | null;
  readonly onPickInjected: (rdns: string) => void;
  readonly onPickWalletConnect: () => void;
  readonly onClose: () => void;
}

/**
 * EVM wallet picker — installed browser extensions (EIP-6963), plus a
 * WalletConnect option that hands off to Reown AppKit's sheet, which lists
 * wallets and deep-links into them on mobile and falls back to a QR on desktop.
 */
export function EvmConnectModal({
  open,
  injectedWallets,
  pairingUri,
  isConnecting,
  error,
  onPickInjected,
  onPickWalletConnect,
  onClose,
}: Readonly<EvmConnectModalProps>) {
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);

  // Reset the sub-view whenever the modal is reopened.
  useEffect(() => {
    if (!open) setShowQr(false);
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  if (!open) return null;

  const onWalletConnectClick = () => {
    setShowQr(true);
    onPickWalletConnect();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-[92vw] max-w-[400px] border border-[var(--line)] bg-[#0c0c0c] p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="m-0 font-space-grotesk text-[1.05rem] font-bold tracking-[-0.02em]">
            {showQr ? "CONTINUE IN YOUR WALLET" : "CONNECT EVM WALLET"}
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

        {error && (
          <p className="mt-0 mb-3 text-[0.72rem] text-red-400">{error}</p>
        )}
        {!showQr && isConnecting && !error && (
          <p className="mt-0 mb-3 text-[0.72rem] text-[var(--accent)]">
            Check your wallet — approve the connection request…
          </p>
        )}

        {showQr ? (
          // AppKit's own sheet takes over from here: it lists wallets and
          // deep-links into them on mobile, where a QR is useless because you
          // cannot scan your own screen. It still shows a QR on desktop.
          <>
            <p className="m-0 text-[0.78rem] leading-relaxed text-[var(--muted)]">
              Choose your wallet in the WalletConnect window, then approve the
              connection there.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                disabled={!pairingUri}
                onClick={() =>
                  pairingUri &&
                  navigator.clipboard?.writeText(pairingUri).then(
                    () => setCopied(true),
                    () => {},
                  )
                }
                className="h-10 border border-[var(--line)] text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[var(--foreground)] hover:border-[#666] disabled:opacity-40"
              >
                {copied ? "Copied ✓" : "Copy pairing link"}
              </button>
              <button
                type="button"
                onClick={() => setShowQr(false)}
                className="h-10 text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[var(--muted)] hover:text-white"
              >
                ← Back to wallet list
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2">
            {injectedWallets.length === 0 && (
              <p className="mt-0 mb-1 text-[0.72rem] text-[var(--muted)]">
                No browser wallet detected. Use WalletConnect, or install an
                extension like MetaMask.
              </p>
            )}
            {injectedWallets.map((w) => (
              <button
                key={w.info.rdns}
                type="button"
                disabled={isConnecting}
                onClick={() => onPickInjected(w.info.rdns)}
                className="flex h-11 items-center gap-3 border border-[var(--line)] px-3 text-left text-[0.85rem] hover:border-[#666] disabled:opacity-40"
              >
                {w.info.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={w.info.icon} alt="" className="h-5 w-5" />
                ) : (
                  <span className="h-5 w-5 shrink-0 rounded-sm bg-[#2a2a2a]" />
                )}
                <span className="font-bold">{w.info.name}</span>
              </button>
            ))}
            <button
              type="button"
              disabled={isConnecting}
              onClick={onWalletConnectClick}
              className="flex h-11 items-center gap-3 border border-[var(--line)] px-3 text-left text-[0.85rem] hover:border-[#666] disabled:opacity-40"
            >
              <span className="h-5 w-5 shrink-0 rounded-sm bg-[#3396ff]" />
              <span className="font-bold">WalletConnect</span>
              <span className="ml-auto text-[0.68rem] text-[var(--muted)]">
                mobile
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
