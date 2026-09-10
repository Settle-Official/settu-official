"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";

// Entry point to accounts from the dashboard. Offramp stays usable without one,
// so this is a way in rather than a gate.
export function AccountLink() {
  const { user, isAuthenticated, isLoading } = useAuth();

  // Render nothing until the session resolves, so the label doesn't flip from
  // "Sign in" to an email on every load.
  if (isLoading) return null;

  return (
    <Link
      href="/account"
      className="text-[0.68rem] uppercase tracking-[0.08em] text-[var(--muted)] transition-colors hover:text-[var(--accent)]"
    >
      {isAuthenticated && user ? user.email : "Sign in"}
    </Link>
  );
}
