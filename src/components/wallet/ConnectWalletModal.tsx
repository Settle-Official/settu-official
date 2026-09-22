"use client";

import { useState } from "react";
import { SettuWalletDialog } from "@/components/wallet/SettuWalletDialog";

// One entry point for both wallet kinds, so the header carries a single
// button and the choice is made with the descriptions in front of the user.
export function ConnectWalletModal({
  onSettuReady,
  onConnectExternal,
  onClose,
}: {
  readonly onSettuReady: (address: string) => void;
  readonly onConnectExternal: () => void;
  readonly onClose: () => void;
}) {
  const [showSettu, setShowSettu] = useState(false);

  if (showSettu) {
    return <SettuWalletDialog onReady={onSettuReady} onClose={onClose} />;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />
      <div className="relative z-10 flex w-full max-w-[400px] flex-col gap-[0.9rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]">
        <h3 className="m-0 font-space-grotesk text-[1.05rem] font-bold">
          CONNECT WALLET
        </h3>

        <div className="grid grid-cols-2 gap-[0.6rem]">
          <button
            type="button"
            onClick={() => setShowSettu(true)}
            style={{ borderColor: "#C9A962" }}
            className="flex flex-col items-center gap-[0.5rem] border p-3 transition-colors hover:bg-[#151515]"
          >
            <OneKeyManyChains />
            <span
              className="text-[0.74rem] font-semibold uppercase tracking-[0.08em]"
              style={{ color: "#C9A962" }}
            >
              Settu Wallet
            </span>
            <span className="text-[0.66rem] text-[var(--muted)]">
              One phrase, every chain
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              onConnectExternal();
              onClose();
            }}
            className="flex flex-col items-center gap-[0.5rem] border border-[var(--line)] p-3 transition-colors hover:border-[#C9A962]"
          >
            <PlugIntoWallet />
            <span className="text-[0.74rem] font-semibold uppercase tracking-[0.08em]">
              External
            </span>
            <span className="text-[0.66rem] text-[var(--muted)]">
              Freighter, MetaMask…
            </span>
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="text-[0.72rem] uppercase tracking-[0.08em] text-[var(--muted)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// One key feeding three chains — the whole proposition without a paragraph.
function OneKeyManyChains() {
  return (
    <svg width="56" height="40" viewBox="0 0 56 40" fill="none" aria-hidden>
      <g stroke="#C9A962" strokeWidth="1.5">
        <circle cx="14" cy="20" r="6" />
        <path d="M20 20h6M26 20l4-9h9M26 20h13M26 20l4 9h9" />
        <circle cx="45" cy="11" r="3.5" fill="#C9A962" fillOpacity="0.25" />
        <circle cx="45" cy="20" r="3.5" fill="#C9A962" fillOpacity="0.25" />
        <circle cx="45" cy="29" r="3.5" fill="#C9A962" fillOpacity="0.25" />
        <path d="M14 20h-6" strokeLinecap="round" />
        <path d="M9 17v6" strokeLinecap="round" />
      </g>
    </svg>
  );
}

// A wallet you already hold, plugged in from outside.
function PlugIntoWallet() {
  return (
    <svg width="56" height="40" viewBox="0 0 56 40" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth="1.5" className="text-[var(--muted)]">
        <rect x="26" y="10" width="22" height="20" rx="3" />
        <path d="M26 16h22" />
        <circle cx="42" cy="23" r="2" fill="currentColor" />
        <path d="M8 20h14" strokeLinecap="round" />
        <path d="M17 15l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
