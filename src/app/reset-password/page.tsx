"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api/client";
import { AuthButton, AuthField } from "@/components/auth/AuthField";
import { clearToken } from "@/lib/api/client";

const MIN_PASSWORD_LENGTH = 12;

function ResetPassword() {
  const token = useSearchParams().get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    !!token && password.length >= MIN_PASSWORD_LENGTH && password === confirm;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/reset-password", { method: "POST", body: { token, password } });
      // The server revokes every session on reset, so any token held here is
      // already dead — drop it rather than leave a stale credential around.
      clearToken();
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen p-4">
      <section className="mx-auto mt-[12vh] flex max-w-[440px] flex-col gap-[1.1rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]">
        <h1 className="m-0 font-space-grotesk text-[1.5rem] font-bold">
          {done ? "PASSWORD CHANGED ✓" : "CHOOSE A NEW PASSWORD"}
        </h1>

        {done ? (
          <p className="m-0 text-[0.8rem] leading-relaxed text-[var(--muted)]">
            Your password is updated and every existing session has been signed
            out. Sign in again with your new password.
          </p>
        ) : !token ? (
          <p className="m-0 text-[0.8rem] text-[var(--muted)]">
            That link is missing its reset code. Request a new one.
          </p>
        ) : (
          <form className="flex flex-col gap-[0.9rem]" onSubmit={handleSubmit}>
            <AuthField
              label="NEW PASSWORD"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              disabled={busy}
            />
            <AuthField
              label="CONFIRM PASSWORD"
              type="password"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              disabled={busy}
            />
            {confirm.length > 0 && password !== confirm && (
              <p className="m-0 text-[0.7rem] text-red-400">Passwords don&apos;t match.</p>
            )}
            {error && <p className="m-0 text-[0.75rem] text-red-400">{error}</p>}
            <AuthButton disabled={!canSubmit || busy}>
              {busy ? "Saving..." : "Change password →"}
            </AuthButton>
          </form>
        )}

        <Link href="/" className="text-[0.72rem] uppercase tracking-[0.08em] text-[var(--accent)]">
          Back to Settu
        </Link>
      </section>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ResetPassword />
    </Suspense>
  );
}
