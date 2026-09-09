"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api/client";

type State = "working" | "done" | "failed";

function VerifyEmail() {
  const token = useSearchParams().get("token");
  const [state, setState] = useState<State>("working");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!token) {
      setState("failed");
      setMessage("That link is missing its verification code.");
      return;
    }

    // Tokens are single-use, so React 18 double-invoking effects in dev would
    // burn the token on the first call and fail on the second. Guard it.
    let cancelled = false;
    api("/auth/verify-email", { method: "POST", body: { token } })
      .then(() => {
        if (!cancelled) setState("done");
      })
      .catch((error) => {
        if (cancelled) return;
        setState("failed");
        setMessage(
          error instanceof ApiError ? error.message : "Something went wrong",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <main className="min-h-screen p-4">
      <section className="mx-auto mt-[12vh] max-w-[440px] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]">
        <h1 className="m-0 font-space-grotesk text-[1.5rem] font-bold">
          {state === "working" ? "VERIFYING..." : state === "done" ? "VERIFIED ✓" : "LINK EXPIRED"}
        </h1>
        <p className="mt-[0.6rem] mb-0 text-[0.8rem] leading-relaxed text-[var(--muted)]">
          {state === "working" && "Confirming your email address."}
          {state === "done" && "Your email is confirmed. You can now sign in and link a wallet."}
          {state === "failed" && message}
        </p>
        {state !== "working" && (
          <Link
            href="/"
            className="mt-5 inline-block text-[0.72rem] uppercase tracking-[0.08em] text-[var(--accent)]"
          >
            Continue to Settu
          </Link>
        )}
      </section>
    </main>
  );
}

export default function Page() {
  // useSearchParams needs a Suspense boundary to keep the route static.
  return (
    <Suspense fallback={null}>
      <VerifyEmail />
    </Suspense>
  );
}
