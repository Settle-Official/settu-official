"use client";

import { useEffect, type ReactNode } from "react";

/**
 * An overlay for a running transaction: the screen behind stays on show,
 * dimmed and blurred, with the flow's own card floating over it.
 *
 * This is deliberately not an in-page swap. Replacing the form with the
 * stepper reads as having navigated somewhere else, and the filled-in form
 * — the amount, the bank, the account — vanishes at exactly the moment the
 * user most wants to see it still sitting there.
 *
 * `dismissable` is false while the transaction is in flight: clicking away
 * from a signature that is still pending should not look like a way out.
 * Once it has resolved, the scrim and Escape both close it, alongside the
 * card's own buttons.
 */
export function FlowModal({
  dismissable,
  onDismiss,
  children,
}: {
  readonly dismissable: boolean;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}) {
  useEffect(() => {
    if (!dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    // The app shell is height-locked and scrolls inside its own panel, so
    // there is no body scroll to lock — only the key handler to clean up.
    return () => document.removeEventListener("keydown", onKey);
  }, [dismissable, onDismiss]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Transaction progress"
      className="fixed inset-0 z-50 flex items-center justify-center p-[20px] max-[720px]:p-[12px]"
    >
      {dismissable ? (
        <button
          type="button"
          aria-label="Close"
          onClick={onDismiss}
          style={{ backgroundColor: "rgba(0,0,0,0.7)" }}
          className="absolute inset-0 backdrop-blur-sm"
        />
      ) : (
        <div
          aria-hidden="true"
          style={{ backgroundColor: "rgba(0,0,0,0.7)" }}
          className="absolute inset-0 backdrop-blur-sm"
        />
      )}

      {/* Scrolls itself: the five-step card plus a Cancel button is taller
          than a short phone in landscape. */}
      <div
        data-lenis-prevent
        className="relative z-10 max-h-[86dvh] w-full max-w-[460px] overflow-y-auto overscroll-contain"
      >
        {children}
      </div>
    </div>
  );
}
