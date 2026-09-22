"use client";

import { useEffect, useState } from "react";
import { AuthButton, AuthField } from "@/components/auth/AuthField";
import { useSettuWallet } from "@/hooks/useSettuWallet";
import { listWallets } from "@/lib/api/wallets";

// Unlocking from the dashboard, where a full wallet panel would be in the way.
// One phrase covers every chain, so there is nothing to choose here.
export function SettuUnlockDialog({
  onUnlocked,
  onClose,
}: {
  readonly onUnlocked: (address: string) => void;
  readonly onClose: () => void;
}) {
  const { unlock, isBusy, error } = useSettuWallet();
  const [walletId, setWalletId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listWallets()
      .then((wallets) => {
        if (cancelled) return;
        const settu = wallets.find((w) => w.is_settu_wallet);
        setWalletId(settu?.id ?? null);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!walletId) return;
    try {
      onUnlocked(await unlock(walletId, { type: "password", secret: password }));
      setPassword("");
    } catch {
      // The hook already surfaced it.
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />
      <form
        onSubmit={handleSubmit}
        className="relative z-10 flex w-full max-w-[380px] flex-col gap-[0.9rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]"
      >
        <h3 className="m-0 font-space-grotesk text-[1.05rem] font-bold">
          UNLOCK YOUR SETTU WALLET
        </h3>

        {loading ? (
          <p className="m-0 text-[0.75rem] text-[var(--muted)]">Loading…</p>
        ) : walletId ? (
          <>
            <p className="m-0 text-[0.75rem] text-[var(--muted)]">
              Unlocks every chain at once — Stellar, Solana and EVM.
            </p>
            <AuthField
              label="PASSWORD"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              disabled={isBusy}
            />
            {error && (
              <p className="m-0 text-[0.75rem] text-[#ff6b6b]">{error}</p>
            )}
            <AuthButton disabled={isBusy}>
              {isBusy ? "Unlocking…" : "Unlock"}
            </AuthButton>
          </>
        ) : (
          <p className="m-0 text-[0.75rem] text-[var(--muted)]">
            You don&apos;t have a Settu wallet yet. Create one from your account
            page.
          </p>
        )}

        <button
          type="button"
          onClick={onClose}
          className="text-[0.72rem] uppercase tracking-[0.08em] text-[var(--muted)]"
        >
          Cancel
        </button>
      </form>
    </div>
  );
}
