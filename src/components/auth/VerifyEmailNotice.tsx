"use client";

import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";

// Verification links expire, so a notice with no way to get a new one is a
// dead end — which is exactly where this left people.
export function VerifyEmailNotice({ email }: { readonly email: string }) {
  const { resendVerification, isBusy } = useAuth();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResend() {
    setError(null);
    try {
      await resendVerification(email);
      setSent(true);
    } catch {
      setError("Couldn't send that right now. Try again in a minute.");
    }
  }

  return (
    <div className="flex flex-col gap-[0.6rem] border border-[var(--accent)] p-3">
      <p className="m-0 text-[0.75rem] text-[var(--accent)]">
        Verify your email to link a wallet. Check your inbox for the link.
      </p>

      {sent ? (
        // Worded as "if it's still unverified" because the server stays silent
        // about which addresses exist.
        <p className="m-0 text-[0.72rem] text-[var(--muted)]">
          Sent. If this address is still unverified, a new link is on its way —
          it replaces any earlier one.
        </p>
      ) : (
        <button
          type="button"
          onClick={handleResend}
          disabled={isBusy}
          className="self-start text-[0.72rem] uppercase tracking-[0.08em] text-[var(--accent)] underline disabled:opacity-60"
        >
          {isBusy ? "Sending…" : "Resend the link"}
        </button>
      )}

      {error && <p className="m-0 text-[0.72rem] text-[#ff6b6b]">{error}</p>}
    </div>
  );
}
