"use client";

import { useState } from "react";
import { AuthButton, AuthField } from "@/components/auth/AuthField";
import { useSettuWallet } from "@/hooks/useSettuWallet";
import { shortAddress } from "@/lib/api/wallets";

// Matches the account password rule, so the two don't disagree on screen.
const MIN_PASSWORD_LENGTH = 12;

type Phase = "create" | "recovery" | "unlock" | "ready";

interface Props {
  readonly walletId?: string;
  readonly onReady?: (address: string) => void;
}

export function SettuWalletPanel({ walletId, onReady }: Props) {
  const { address, isBusy, error, create, unlock, lock } = useSettuWallet();
  const [phase, setPhase] = useState<Phase>(
    address ? "ready" : walletId ? "unlock" : "create",
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [savedCode, setSavedCode] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const shown = localError ?? error;

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setLocalError(null);
    try {
      const result = await create(password);
      setRecoveryCode(result.recoveryCode);
      setPassword("");
      setConfirm("");
      setPhase("recovery");
    } catch {
      // The hook already surfaced it.
    }
  }

  async function handleUnlock(event: React.FormEvent) {
    event.preventDefault();
    setLocalError(null);
    if (!walletId) return;
    try {
      const opened = await unlock(
        walletId,
        useRecovery
          ? { type: "recovery", secret: recoveryCode }
          : { type: "password", secret: password },
      );
      setPassword("");
      setRecoveryCode("");
      setPhase("ready");
      onReady?.(opened);
    } catch {
      // The hook already surfaced it.
    }
  }

  if (phase === "recovery") {
    return (
      <section className="flex flex-col gap-[1rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]">
        <div>
          <h2 className="m-0 font-space-grotesk text-[1.1rem] font-bold">
            SAVE YOUR RECOVERY CODE
          </h2>
          <p className="mt-[0.4rem] mb-0 text-[0.78rem] text-[var(--muted)]">
            This is the only way back in if you forget your password. We cannot
            recover it for you, and without it the funds are gone for good.
          </p>
        </div>

        <div
          className="select-all border px-3 py-4 text-center font-mono text-[1.05rem] tracking-[0.15em]"
          style={{ borderColor: "#C9A962", color: "#C9A962" }}
        >
          {recoveryCode}
        </div>

        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(recoveryCode);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="h-10 border border-[var(--line)] text-[0.72rem] uppercase tracking-[0.08em] text-[var(--muted)]"
        >
          {copied ? "Copied" : "Copy code"}
        </button>

        <label className="flex items-start gap-2 text-[0.75rem] text-[var(--muted)]">
          <input
            type="checkbox"
            checked={savedCode}
            onChange={(event) => setSavedCode(event.target.checked)}
            className="mt-[0.15rem]"
          />
          I have saved this code somewhere safe.
        </label>

        <AuthButton
          type="button"
          disabled={!savedCode}
          onClick={() => {
            setRecoveryCode("");
            setPhase("ready");
            if (address) onReady?.(address);
          }}
        >
          Continue
        </AuthButton>
      </section>
    );
  }

  if (phase === "ready" && address) {
    return (
      <section className="flex flex-col gap-[0.9rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]">
        <div>
          <h2 className="m-0 font-space-grotesk text-[1.1rem] font-bold">
            YOUR SETTU WALLET
          </h2>
          <p className="mt-[0.35rem] mb-0 font-mono text-[0.85rem]">
            {shortAddress(address)}
          </p>
        </div>
        <p className="m-0 text-[0.72rem] text-[var(--muted)]">
          Locks itself after 15 minutes of inactivity.
        </p>
        <button
          type="button"
          onClick={() => {
            lock();
            setPhase(walletId ? "unlock" : "create");
          }}
          className="h-10 border border-[var(--line)] text-[0.72rem] uppercase tracking-[0.08em] text-[var(--muted)]"
        >
          Lock
        </button>
      </section>
    );
  }

  if (phase === "unlock") {
    return (
      <form
        onSubmit={handleUnlock}
        className="flex flex-col gap-[0.9rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]"
      >
        <h2 className="m-0 font-space-grotesk text-[1.1rem] font-bold">
          UNLOCK YOUR WALLET
        </h2>

        {useRecovery ? (
          <AuthField
            label="RECOVERY CODE"
            type="password"
            value={recoveryCode}
            onChange={setRecoveryCode}
            autoComplete="one-time-code"
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
            disabled={isBusy}
          />
        ) : (
          <AuthField
            label="PASSWORD"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            disabled={isBusy}
          />
        )}

        {shown && <p className="m-0 text-[0.75rem] text-[#ff6b6b]">{shown}</p>}

        <AuthButton disabled={isBusy}>
          {isBusy ? "Unlocking…" : "Unlock"}
        </AuthButton>

        <button
          type="button"
          onClick={() => {
            setUseRecovery((value) => !value);
            setLocalError(null);
          }}
          className="text-[0.72rem] text-[var(--muted)] underline"
        >
          {useRecovery ? "Use my password" : "Use my recovery code instead"}
        </button>
      </form>
    );
  }

  const canCreate =
    password.length >= MIN_PASSWORD_LENGTH && password === confirm && !isBusy;

  return (
    <form
      onSubmit={handleCreate}
      className="flex flex-col gap-[0.9rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]"
    >
      <div>
        <h2 className="m-0 font-space-grotesk text-[1.1rem] font-bold">
          CREATE A SETTU WALLET
        </h2>
        <p className="mt-[0.35rem] mb-0 text-[0.78rem] text-[var(--muted)]">
          Holds USDC and any Stellar asset. Your key is encrypted on this device
          — Settu stores it sealed and cannot open it.
        </p>
      </div>

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

      {shown && <p className="m-0 text-[0.75rem] text-[#ff6b6b]">{shown}</p>}

      <AuthButton disabled={!canCreate}>
        {isBusy ? "Creating…" : "Create wallet"}
      </AuthButton>
    </form>
  );
}
