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

        <button
          type="button"
          onClick={() => setShowSettu(true)}
          style={{ borderColor: "#C9A962" }}
          className="flex flex-col gap-[0.25rem] border p-3 text-left transition-colors hover:bg-[#151515]"
        >
          <span
            className="text-[0.8rem] font-semibold uppercase tracking-[0.08em]"
            style={{ color: "#C9A962" }}
          >
            Settu Wallet
          </span>
          <span className="text-[0.72rem] text-[var(--muted)]">
            Create one in seconds or unlock the one you have. Covers Stellar,
            Solana and EVM from a single recovery phrase.
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            onConnectExternal();
            onClose();
          }}
          className="flex flex-col gap-[0.25rem] border border-[var(--line)] p-3 text-left transition-colors hover:border-[#C9A962]"
        >
          <span className="text-[0.8rem] font-semibold uppercase tracking-[0.08em]">
            External Wallet
          </span>
          <span className="text-[0.72rem] text-[var(--muted)]">
            Connect Freighter, MetaMask, Phantom or any WalletConnect wallet you
            already use.
          </span>
        </button>

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
