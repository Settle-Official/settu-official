"use client";

import { useEffect, useState } from "react";
import { AuthButton, AuthField } from "@/components/auth/AuthField";
import { useSettuWallet, type PreparedWallet } from "@/hooks/useSettuWallet";
import { listWallets, shortAddress } from "@/lib/api/wallets";
import {
  fetchBalances,
  formatAmount,
  type WalletBalance,
} from "@/lib/settu-wallet/balances";

// Matches the account password rule, so the two don't disagree on screen.
const MIN_PASSWORD_LENGTH = 12;

type Phase = "create" | "recovery" | "unlock" | "recover" | "ready";

interface Props {
  readonly onReady?: (address: string) => void;
}

export function SettuWalletPanel({ onReady }: Props) {
  const {
    address,
    isBusy,
    error,
    prepare,
    finalize,
    unlock,
    recoverWithPhrase,
    deriveSolana,
    lock,
  } = useSettuWallet();
  const [walletId, setWalletId] = useState<string | undefined>();
  const [phase, setPhase] = useState<Phase>(address ? "ready" : "create");

  // Resolve an existing Settu wallet so the panel offers unlock, not create.
  useEffect(() => {
    let cancelled = false;
    listWallets()
      .then((wallets) => {
        const solana = wallets.find(
          (w) => w.chain_family === "solana" && w.is_settu_wallet,
        );
        if (!cancelled && solana) setSolanaAddress(solana.address);

        const existing = wallets.find(
          (w) => w.chain_family === "stellar" && w.is_settu_wallet,
        );
        if (cancelled || !existing) return;
        setWalletId(existing.id);
        setPhase((current) => (current === "create" ? "unlock" : current));
      })
      .catch(() => {
        // Not signed in, or the list failed — creating is still valid.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [phrase, setPhrase] = useState("");
  const [savedPhrase, setSavedPhrase] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<PreparedWallet | null>(null);
  const [pendingPassword, setPendingPassword] = useState("");
  const [balances, setBalances] = useState<WalletBalance[] | null>(null);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
  const [solanaPassword, setSolanaPassword] = useState("");
  const [addingSolana, setAddingSolana] = useState(false);
  const [needsUpgrade, setNeedsUpgrade] = useState(false);
  const [upgradePhrase, setUpgradePhrase] = useState("");

  // Refreshed whenever the wallet is open, so a deposit shows without a reload.
  useEffect(() => {
    if (phase !== "ready" || !address) return;
    let cancelled = false;
    const load = () =>
      fetchBalances(address)
        .then((next) => !cancelled && setBalances(next))
        .catch(() => {});
    load();
    const timer = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, address]);

  const shown = localError ?? error;

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setLocalError(null);
    try {
      const prepared = await prepare(password);
      setPending(prepared);
      setPendingPassword(password);
      setPhrase(prepared.mnemonic);
      setPassword("");
      setConfirm("");
      setPhase("recovery");
    } catch {
      // The hook already surfaced it.
    }
  }

  // Only now does anything reach the network, so a failure here still leaves a
  // wallet recoverable from the phrase the user has just saved.
  async function handleConfirmPhrase() {
    if (!pending) return;
    setLocalError(null);
    try {
      const result = await finalize(pending, pendingPassword);
      setWalletId(result.walletId);
      setPending(null);
      setPendingPassword("");
      setPhrase("");
      setPhase("ready");
      onReady?.(result.address);
    } catch {
      // Stay put: the phrase on screen is still the only copy.
    }
  }

  async function handleUnlock(event: React.FormEvent) {
    event.preventDefault();
    setLocalError(null);
    if (!walletId) return;
    try {
      const opened = await unlock(walletId, {
        type: "password",
        secret: password,
      });
      setPassword("");
      setPhase("ready");
      onReady?.(opened);
    } catch {
      // The hook already surfaced it.
    }
  }

  // The phrase is for recovery, not routine unlocking, so it always ends in a
  // new password rather than opening the wallet once.
  async function handleRecover(event: React.FormEvent) {
    event.preventDefault();
    setLocalError(null);
    if (!walletId) return;
    if (password.length < MIN_PASSWORD_LENGTH || password !== confirm) {
      setLocalError("Choose a new password of at least 12 characters.");
      return;
    }
    try {
      const opened = await recoverWithPhrase(walletId, phrase, password);
      setPhrase("");
      setPassword("");
      setConfirm("");
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
            SAVE YOUR RECOVERY PHRASE
          </h2>
          <p className="mt-[0.4rem] mb-0 text-[0.78rem] text-[var(--muted)]">
            These 24 words are your wallet. They restore it if you forget your
            password, and they work in Freighter or LOBSTR even if Settu is
            gone. Anyone who has them can spend your funds, and we cannot
            recover them for you.
          </p>
        </div>

        <ol className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 p-0 sm:grid-cols-3">
          {phrase.split(" ").map((word, index) => (
            <li
              key={`${index}-${word}`}
              className="flex gap-2 font-mono text-[0.8rem]"
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
            navigator.clipboard?.writeText(phrase);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="h-10 border border-[var(--line)] text-[0.72rem] uppercase tracking-[0.08em] text-[var(--muted)]"
        >
          {copied ? "Copied" : "Copy phrase"}
        </button>

        <label className="flex items-start gap-2 text-[0.75rem] text-[var(--muted)]">
          <input
            type="checkbox"
            checked={savedPhrase}
            onChange={(event) => setSavedPhrase(event.target.checked)}
            className="mt-[0.15rem]"
          />
          I have written these words down somewhere safe.
        </label>

        {shown && <p className="m-0 text-[0.75rem] text-[#ff6b6b]">{shown}</p>}

        <AuthButton
          type="button"
          disabled={!savedPhrase || isBusy}
          onClick={handleConfirmPhrase}
        >
          {isBusy ? "Creating…" : "Continue"}
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
          <div className="mt-[0.35rem] flex items-center gap-2">
            <p className="m-0 font-mono text-[0.85rem]">
              {shortAddress(address)}
            </p>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(address);
                setCopiedAddress(true);
                setTimeout(() => setCopiedAddress(false), 1500);
              }}
              className="border border-[var(--line)] px-2 py-[0.15rem] text-[0.62rem] uppercase tracking-[0.08em] text-[var(--muted)]"
            >
              {copiedAddress ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-[0.35rem]">
          {balances === null ? (
            <p className="m-0 text-[0.72rem] text-[var(--muted)]">
              Loading balance…
            </p>
          ) : balances.length === 0 ? (
            <p className="m-0 text-[0.72rem] text-[var(--muted)]">
              No funds yet. Send USDC to the address above.
            </p>
          ) : (
            balances.map((balance) => (
              <div
                key={`${balance.code}-${balance.issuer ?? "native"}`}
                className="flex items-baseline justify-between border border-[var(--line)] px-3 py-2"
              >
                <span className="text-[0.72rem] tracking-[0.08em] text-[var(--muted)]">
                  {balance.code}
                </span>
                <span className="font-mono text-[0.95rem]">
                  {formatAmount(balance.amount)}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="h-px bg-[var(--line)]" />

        {solanaAddress ? (
          <div>
            <p className="m-0 text-[0.69rem] tracking-[0.08em] text-[var(--muted)]">
              SOLANA
            </p>
            <p className="mt-[0.2rem] mb-0 font-mono text-[0.8rem]">
              {shortAddress(solanaAddress)}
            </p>
          </div>
        ) : needsUpgrade ? (
          <form
            className="flex flex-col gap-[0.5rem]"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!walletId) return;
              setLocalError(null);
              try {
                // Reseals as v2 under the same password, then derives.
                await recoverWithPhrase(walletId, upgradePhrase, solanaPassword);
                setSolanaAddress(await deriveSolana(walletId, solanaPassword));
                setUpgradePhrase("");
                setSolanaPassword("");
                setNeedsUpgrade(false);
                setAddingSolana(false);
              } catch {
                // The hook already surfaced it.
              }
            }}
          >
            <p className="m-0 text-[0.75rem] text-[var(--muted)]">
              This wallet was created before multi-chain support. Enter your 24
              words once to enable other chains — your wallet and funds are
              unchanged.
            </p>
            <textarea
              value={upgradePhrase}
              onChange={(event) => setUpgradePhrase(event.target.value)}
              rows={3}
              placeholder="Your 24 words, separated by spaces"
              disabled={isBusy}
              className="border border-[var(--line)] bg-transparent p-[0.8rem] font-mono text-[0.85rem] outline-none placeholder:text-[var(--muted)] disabled:opacity-50"
            />
            <AuthField
              label="YOUR PASSWORD"
              type="password"
              value={solanaPassword}
              onChange={setSolanaPassword}
              autoComplete="current-password"
              disabled={isBusy}
            />
            {shown && (
              <p className="m-0 text-[0.72rem] text-[#ff6b6b]">{shown}</p>
            )}
            <AuthButton disabled={isBusy}>
              {isBusy ? "Enabling…" : "Enable multi-chain"}
            </AuthButton>
          </form>
        ) : addingSolana ? (
          <form
            className="flex flex-col gap-[0.5rem]"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!walletId) return;
              setLocalError(null);
              try {
                setSolanaAddress(await deriveSolana(walletId, solanaPassword));
                setSolanaPassword("");
                setAddingSolana(false);
              } catch (err: any) {
                // A v1 envelope holds no phrase, so ask for it rather than
                // leaving the user to find the recovery screen themselves.
                if (/predates multi-chain/i.test(err?.message ?? "")) {
                  setNeedsUpgrade(true);
                }
              }
            }}
          >
            <AuthField
              label="CONFIRM PASSWORD TO ADD SOLANA"
              type="password"
              value={solanaPassword}
              onChange={setSolanaPassword}
              autoComplete="current-password"
              disabled={isBusy}
            />
            {shown && (
              <p className="m-0 text-[0.72rem] text-[#ff6b6b]">{shown}</p>
            )}
            <AuthButton disabled={isBusy}>
              {isBusy ? "Adding…" : "Add Solana wallet"}
            </AuthButton>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAddingSolana(true)}
            className="h-10 border border-[var(--line)] text-[0.72rem] uppercase tracking-[0.08em] text-[var(--muted)]"
          >
            Add Solana wallet
          </button>
        )}

        <p className="m-0 text-[0.72rem] text-[var(--muted)]">
          Same recovery phrase covers every chain. Locks itself after 15 minutes
          of inactivity.
        </p>
        <button
          type="button"
          onClick={() => {
            lock();
            setBalances(null);
            setPhase(walletId ? "unlock" : "create");
          }}
          className="h-10 border border-[var(--line)] text-[0.72rem] uppercase tracking-[0.08em] text-[var(--muted)]"
        >
          Lock
        </button>
      </section>
    );
  }

  if (phase === "recover") {
    return (
      <form
        onSubmit={handleRecover}
        className="flex flex-col gap-[0.9rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]"
      >
        <div>
          <h2 className="m-0 font-space-grotesk text-[1.1rem] font-bold">
            RECOVER WITH YOUR PHRASE
          </h2>
          <p className="mt-[0.35rem] mb-0 text-[0.78rem] text-[var(--muted)]">
            Enter your 24 words and choose a new password. Your wallet and its
            funds stay exactly as they are.
          </p>
        </div>

        <div className="flex flex-col gap-[0.4rem]">
          <label className="text-[0.69rem] tracking-[0.08em] text-[var(--muted)]">
            RECOVERY PHRASE
          </label>
          <textarea
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            rows={3}
            placeholder="Your 24 words, separated by spaces"
            disabled={isBusy}
            className="border border-[var(--line)] bg-transparent p-[0.8rem] font-mono text-[0.85rem] outline-none placeholder:text-[var(--muted)] disabled:opacity-50"
          />
        </div>

        <AuthField
          label={`NEW PASSWORD (${MIN_PASSWORD_LENGTH}+ CHARACTERS)`}
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          disabled={isBusy}
        />
        <AuthField
          label="CONFIRM NEW PASSWORD"
          type="password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          disabled={isBusy}
        />

        {shown && <p className="m-0 text-[0.75rem] text-[#ff6b6b]">{shown}</p>}

        <AuthButton disabled={isBusy}>
          {isBusy ? "Recovering…" : "Set new password"}
        </AuthButton>

        <button
          type="button"
          onClick={() => {
            setPhrase("");
            setPassword("");
            setConfirm("");
            setLocalError(null);
            setPhase("unlock");
          }}
          className="text-[0.72rem] text-[var(--muted)] underline"
        >
          Back
        </button>
      </form>
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

        <AuthField
          label="PASSWORD"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          disabled={isBusy}
        />

        {shown && <p className="m-0 text-[0.75rem] text-[#ff6b6b]">{shown}</p>}

        <AuthButton disabled={isBusy}>
          {isBusy ? "Unlocking…" : "Unlock"}
        </AuthButton>

        <button
          type="button"
          onClick={() => {
            setPassword("");
            setLocalError(null);
            setPhase("recover");
          }}
          className="text-[0.72rem] text-[var(--muted)] underline"
        >
          Forgot your password?
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
