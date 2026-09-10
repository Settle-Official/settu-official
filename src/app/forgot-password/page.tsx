"use client";

import { useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api/client";
import { AuthButton, AuthField } from "@/components/auth/AuthField";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/forgot-password", { method: "POST", body: { email } });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen p-4">
      <section className="mx-auto mt-[12vh] flex max-w-[440px] flex-col gap-[1.1rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]">
        <h1 className="m-0 font-space-grotesk text-[1.5rem] font-bold">RESET PASSWORD</h1>

        {sent ? (
          // Neutral either way — confirming whether the address exists would
          // turn this page into an account-enumeration oracle.
          <p className="m-0 text-[0.8rem] leading-relaxed text-[var(--muted)]">
            If that address has an account, a reset link is on its way. It expires
            in 15 minutes and can only be used once.
          </p>
        ) : (
          <form className="flex flex-col gap-[0.9rem]" onSubmit={handleSubmit}>
            <AuthField
              label="EMAIL"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
              placeholder="you@example.com"
              disabled={busy}
            />
            {error && <p className="m-0 text-[0.75rem] text-red-400">{error}</p>}
            <AuthButton disabled={!email.trim() || busy}>
              {busy ? "Sending..." : "Send reset link →"}
            </AuthButton>
          </form>
        )}

        <Link
          href="/"
          className="text-[0.72rem] uppercase tracking-[0.08em] text-[var(--accent)]"
        >
          Back to Settu
        </Link>
      </section>
    </main>
  );
}
