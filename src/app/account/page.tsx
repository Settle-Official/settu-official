"use client";

import Link from "next/link";
import { AuthPanel } from "@/components/auth/AuthPanel";
import { LinkedWallets } from "@/components/auth/LinkedWallets";
import { useAuth } from "@/hooks/useAuth";

export default function Account() {
  const { user, isAuthenticated, isLoading, logout, refresh } = useAuth();

  return (
    <main className="min-h-screen p-4">
      <section className="mx-auto mt-[8vh] max-w-[520px]">
        {isLoading ? (
          <p className="text-[0.8rem] text-[var(--muted)]">Loading...</p>
        ) : isAuthenticated && user ? (
          <div className="flex flex-col gap-[1.1rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]">
            <div>
              <h1 className="m-0 font-space-grotesk text-[1.5rem] font-bold">ACCOUNT</h1>
              <p className="mt-[0.3rem] mb-0 font-mono text-[0.8rem] text-[var(--muted)]">
                {user.email}
              </p>
            </div>

            {!user.email_verified && (
              // Linking is blocked server-side until this is done, so say so
              // rather than letting the attempt fail later with a stray error.
              <div className="border border-[var(--accent)] p-3">
                <p className="m-0 text-[0.75rem] text-[var(--accent)]">
                  Verify your email to link a wallet. Check your inbox for the link.
                </p>
              </div>
            )}

            <div className="h-px bg-[var(--line)]" />

            <LinkedWallets emailVerified={user.email_verified} />

            <div className="h-px bg-[var(--line)]" />

            <div className="flex items-center justify-between text-[0.72rem]">
              <Link href="/" className="uppercase tracking-[0.08em] text-[var(--accent)]">
                Back to Settu
              </Link>
              <button
                type="button"
                onClick={() => logout()}
                className="uppercase tracking-[0.08em] text-[var(--muted)] hover:text-[var(--accent)]"
              >
                Sign out
              </button>
            </div>
          </div>
        ) : (
          <AuthPanel onAuthenticated={refresh} />
        )}
      </section>
    </main>
  );
}
