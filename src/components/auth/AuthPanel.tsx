"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthButton, AuthField } from "./AuthField";
import { authErrorMessage, useAuth } from "@/hooks/useAuth";

// Server enforces this too; shown here so the rule isn't a surprise on submit.
const MIN_PASSWORD_LENGTH = 12;

type Mode = "login" | "signup";

export function AuthPanel({ onAuthenticated }: { readonly onAuthenticated?: () => void }) {
  const { login, signup, isBusy } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const isSignup = mode === "signup";
  const canSubmit =
    email.trim().length > 0 &&
    password.length >= MIN_PASSWORD_LENGTH &&
    (!isSignup || password === confirm);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setSent(false);
    setPassword("");
    setConfirm("");
  };

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (isSignup) {
        await signup(email, password);
        setSent(true);
      } else {
        await login(email, password);
        onAuthenticated?.();
      }
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }

  // Signup never reveals whether the address was already registered, so the
  // confirmation is deliberately neutral.
  if (sent) {
    return (
      <section className="border border-[var(--line)] bg-[#0a0a0a] p-4">
        <h2 className="mt-0 mb-[0.65rem] font-space-grotesk text-[1.13rem] font-bold">
          CHECK YOUR EMAIL
        </h2>
        <p className="m-0 text-[0.78rem] leading-relaxed text-[var(--muted)]">
          If that address can be registered, a verification link is on its way. The
          link expires in 24 hours.
        </p>
        <button
          type="button"
          onClick={() => switchMode("login")}
          className="mt-4 text-[0.72rem] uppercase tracking-[0.08em] text-[var(--accent)]"
        >
          Back to sign in
        </button>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-[1.1rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]">
      <div>
        <h2 className="m-0 font-space-grotesk text-[1.5rem] font-bold">
          {isSignup ? "CREATE ACCOUNT" : "SIGN IN"}
        </h2>
        <p className="mt-[0.3rem] mb-0 text-[0.75rem] text-[var(--muted)]">
          One account, all your wallets across Stellar and EVM chains.
        </p>
      </div>

      <form className="flex flex-col gap-[0.9rem]" onSubmit={handleSubmit}>
        <AuthField
          label="EMAIL"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          placeholder="you@example.com"
          disabled={isBusy}
        />
        <AuthField
          label="PASSWORD"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete={isSignup ? "new-password" : "current-password"}
          placeholder={isSignup ? `At least ${MIN_PASSWORD_LENGTH} characters` : undefined}
          disabled={isBusy}
        />
        {isSignup && (
          <AuthField
            label="CONFIRM PASSWORD"
            type="password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            disabled={isBusy}
          />
        )}

        {isSignup && password.length > 0 && password.length < MIN_PASSWORD_LENGTH && (
          <p className="m-0 text-[0.7rem] text-[var(--muted)]">
            {MIN_PASSWORD_LENGTH - password.length} more characters needed.
          </p>
        )}
        {isSignup && confirm.length > 0 && password !== confirm && (
          <p className="m-0 text-[0.7rem] text-red-400">Passwords don&apos;t match.</p>
        )}
        {error && <p className="m-0 text-[0.75rem] text-red-400">{error}</p>}

        <AuthButton disabled={!canSubmit || isBusy}>
          {isBusy ? "Working..." : isSignup ? "Create account →" : "Sign in →"}
        </AuthButton>
      </form>

      <div className="flex items-center justify-between text-[0.72rem]">
        <button
          type="button"
          onClick={() => switchMode(isSignup ? "login" : "signup")}
          className="uppercase tracking-[0.08em] text-[var(--accent)]"
        >
          {isSignup ? "Have an account? Sign in" : "Create an account"}
        </button>
        {!isSignup && (
          <Link
            href="/forgot-password"
            className="uppercase tracking-[0.08em] text-[var(--muted)] hover:text-[var(--accent)]"
          >
            Forgot password
          </Link>
        )}
      </div>
    </section>
  );
}
