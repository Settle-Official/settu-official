"use client";

import { useEffect, useState } from "react";
import { AuthButton, AuthField } from "@/components/auth/AuthField";
import { useSettuWallet, type PreparedWallet } from "@/hooks/useSettuWallet";
import { listWallets } from "@/lib/api/wallets";

const MIN_PASSWORD_LENGTH = 12;

type Phase = "loading" | "unlock" | "create" | "phrase";

// Unlocks an existing wallet or creates one, from wherever the user asked to
// connect. One phrase covers every chain, so there is nothing to choose here.
export function SettuWalletDialog({
  onReady,
  onClose,
}: {
  readonly onReady: (address: string) => void;
  readonly onClose: () => void;
}) {
  const { unlock, prepare, finalize, isBusy, error } = useSettuWallet();
  const [phase, setPhase] = useState<Phase>("loading");
  const [walletId, setWalletId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState<PreparedWallet | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listWallets()
      .then((wallets) => {
        if (cancelled) return;
        const settu = wallets.find((w) => w.is_settu_wallet);
        setWalletId(settu?.id ?? null);
        setPhase(settu ? "unlock" : "create");
      })
      .catch(() => !cancelled && setPhase("create"));
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleUnlock(event: React.FormEvent) {
    event.preventDefault();
    if (!walletId) return;
    try {
      onReady(await unlock(walletId, { type: "password", secret: password }));
    } catch {
      // The hook already surfaced it.
    }
  }

  // Nothing reaches the network until the phrase is acknowledged, so an
  // abandoned attempt here costs nothing.
  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    try {
      setPending(await prepare(password));
      setPhase("phrase");
    } catch {
      // The hook already surfaced it.
    }
  }

  async function handleConfirmPhrase() {
    if (!pending) return;
    try {
      const result = await finalize(pending, password);
      onReady(result.address);
    } catch {
      // Stay put: the phrase on screen is still the only copy.
    }
  }

  const canCreate =
    password.length >= MIN_PASSWORD_LENGTH && password === confirm && !isBusy;

  return (
    <Shell onClose={onClose} title={titleFor(phase)}>
      {phase === "loading" && (
        <p className="m-0 text-[0.75rem] text-[var(--muted)]">Loading…</p>
      )}

      {phase === "unlock" && (
        <form onSubmit={handleUnlock} className="flex flex-col gap-[0.9rem]">
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
          {error && <p className="m-0 text-[0.75rem] text-[#ff6b6b]">{error}</p>}
          <AuthButton disabled={isBusy}>
            {isBusy ? "Unlocking…" : "Unlock"}
          </AuthButton>
        </form>
      )}

      {phase === "create" && (
        <form onSubmit={handleCreate} className="flex flex-col gap-[0.9rem]">
          <p className="m-0 text-[0.75rem] text-[var(--muted)]">
            Holds USDC and any Stellar asset, plus Solana and EVM. Your key is
            encrypted on this device — Settu stores it sealed and cannot open it.
          </p>
          <AuthField
            label={`PASSWORD (${MIN_PASSWORD_LENGTH}+ CHARACTERS)`}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            disabled={isBusy}
          />
          <AuthField
            label="CONFIRM PASSWORD"
            type="password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            disabled={isBusy}
          />
          {error && <p className="m-0 text-[0.75rem] text-[#ff6b6b]">{error}</p>}
          <AuthButton disabled={!canCreate}>
            {isBusy ? "Preparing…" : "Create wallet"}
          </AuthButton>
        </form>
      )}

      {phase === "phrase" && pending && (
        <div className="flex flex-col gap-[0.9rem]">
          <p className="m-0 text-[0.75rem] text-[var(--muted)]">
            These 24 words are your wallet. They restore it if you forget your
            password, and they work in Freighter, Phantom or MetaMask even if
            Settu is gone. We cannot recover them for you.
          </p>
          <ol className="m-0 grid max-h-[40vh] list-none grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto p-0 sm:grid-cols-3">
            {pending.mnemonic.split(" ").map((word, index) => (
              <li
                key={`${index}-${word}`}
                className="flex gap-2 font-mono text-[0.78rem]"
              >
                <span className="w-5 text-right text-[var(--muted)]">
                  {index + 1}
                </span>
                <span style={{ color: "#C9A962" }}>{word}</span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(pending.mnemonic);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="h-9 border border-[var(--line)] text-[0.7rem] uppercase tracking-[0.08em] text-[var(--muted)]"
          >
            {copied ? "Copied" : "Copy phrase"}
          </button>
          <label className="flex items-start gap-2 text-[0.74rem] text-[var(--muted)]">
            <input
              type="checkbox"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
              className="mt-[0.15rem]"
            />
            I have written these words down somewhere safe.
          </label>
          {error && <p className="m-0 text-[0.75rem] text-[#ff6b6b]">{error}</p>}
          <AuthButton
            type="button"
            disabled={!saved || isBusy}
            onClick={handleConfirmPhrase}
          >
            {isBusy ? "Creating…" : "Continue"}
          </AuthButton>
        </div>
      )}
    </Shell>
  );
}

function titleFor(phase: Phase): string {
  if (phase === "create") return "CREATE YOUR SETTU WALLET";
  if (phase === "phrase") return "SAVE YOUR RECOVERY PHRASE";
  return "UNLOCK YOUR SETTU WALLET";
}

function Shell({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}) {
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
          {title}
        </h3>
        {children}
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
