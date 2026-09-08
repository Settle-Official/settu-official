"use client";

import { useEffect, useState } from "react";

export type OfframpStep =
  | "idle"
  | "initiating"
  | "awaiting-signature"
  | "submitting"
  | "processing"
  | "settling"
  | "success"
  | "error";

interface StepConfig {
  label: string;
  key: OfframpStep;
}

// Brand palette (globals.css :root) — gold, its light highlight, and white.
const CONFETTI_COLORS = ["#c9a962", "#f4e1ad", "#ffffff"];

/**
 * Pre-computed so the burst is scattered but identical on server and client —
 * calling Math.random() during render would desync hydration. A tiny LCG gives
 * the scatter without any runtime animation work; the motion itself is CSS.
 */
const CONFETTI_PIECES = (() => {
  let seed = 20260908;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return Array.from({ length: 40 }, (_, i) => ({
    id: i,
    left: `${next() * 100}%`,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    drift: `${(next() - 0.5) * 140}px`,
    delay: `${next() * 1.1}s`,
    duration: `${1.9 + next() * 1.2}s`,
    spin: `${360 + next() * 540}deg`,
    width: `${5 + next() * 4}px`,
    round: next() > 0.7,
  }));
})();

const STEPS: StepConfig[] = [
  { key: "initiating", label: "Initiating Offramp..." },
  { key: "awaiting-signature", label: "Confirm transaction in wallet" },
  { key: "submitting", label: "Submitting on Stellar" },
  { key: "processing", label: "Transaction processing" },
  { key: "settling", label: "Confirming settlement in fiat" },
];

function getStepIndex(step: OfframpStep): number {
  const idx = STEPS.findIndex((s) => s.key === step);
  return idx === -1 ? -1 : idx;
}

interface TransactionProgressModalProps {
  readonly isOpen: boolean;
  readonly currentStep: OfframpStep;
  readonly error?: string | null;
  readonly onClose?: () => void;
}

export function TransactionProgressModal({
  isOpen,
  currentStep,
  error,
  onClose,
}: TransactionProgressModalProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // Small delay for mount animation
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isSuccess = currentStep === "success";
  const isError = currentStep === "error";
  const isDone = isSuccess || isError;
  const activeIndex = getStepIndex(currentStep);

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={isDone ? onClose : undefined}
      />

      {/* Modal with racing border */}
      <div className="racing-border-wrapper relative z-10">
        <div className="racing-border-content min-w-[380px] max-w-[440px] max-[500px]:min-w-[90vw] bg-[#0c0c0c] p-6">
          {/* Header */}
          <div className="mb-5 flex items-center justify-between">
            <h3 className="m-0 font-space-grotesk text-[1.1rem] font-bold tracking-[-0.02em]">
              {isSuccess
                ? "OFFRAMP COMPLETE"
                : isError
                  ? "OFFRAMP FAILED"
                  : "PROCESSING OFFRAMP"}
            </h3>
            {isDone && onClose && (
              <button
                type="button"
                onClick={onClose}
                className="text-[var(--muted)] hover:text-white transition-colors text-[1.2rem] leading-none"
              >
                ✕
              </button>
            )}
          </div>

          {/* Log steps */}
          <div className="flex flex-col gap-[0.1rem] font-mono text-[0.82rem]">
            {STEPS.map((step, i) => {
              const isPast = activeIndex > i || isSuccess;
              const isCurrent = activeIndex === i && !isDone;
              const isFuture = activeIndex < i && !isSuccess;

              return (
                <div
                  key={step.key}
                  className={`flex items-center gap-3 py-[0.45rem] px-3 transition-all duration-300 ${
                    isCurrent
                      ? "bg-[#1a1a1a] text-white"
                      : isPast
                        ? "text-[var(--accent)]"
                        : "text-[var(--muted)] opacity-40"
                  }`}
                >
                  {/* Status indicator */}
                  <span className="flex-shrink-0 w-5 text-center">
                    {isPast ? (
                      <span className="text-[var(--accent)]">✓</span>
                    ) : isCurrent ? (
                      <span className="inline-block animate-spin-slow">◌</span>
                    ) : (
                      <span className="text-[0.6rem]">○</span>
                    )}
                  </span>
                  <span>{step.label}</span>
                  {isCurrent && (
                    <span className="ml-auto flex gap-[3px]">
                      <span
                        className="dot-bounce inline-block w-[4px] h-[4px] rounded-full bg-[var(--accent)]"
                        style={{ animationDelay: "0ms" }}
                      />
                      <span
                        className="dot-bounce inline-block w-[4px] h-[4px] rounded-full bg-[var(--accent)]"
                        style={{ animationDelay: "150ms" }}
                      />
                      <span
                        className="dot-bounce inline-block w-[4px] h-[4px] rounded-full bg-[var(--accent)]"
                        style={{ animationDelay: "300ms" }}
                      />
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Success state */}
          {isSuccess && (
            <div className="relative mt-5 flex flex-col items-center gap-3 py-4">
              <div className="confetti-layer" aria-hidden="true">
                {CONFETTI_PIECES.map((p) => (
                  <span
                    key={p.id}
                    className="confetti-piece"
                    style={
                      {
                        left: p.left,
                        width: p.width,
                        background: p.color,
                        borderRadius: p.round ? "9999px" : "1px",
                        "--confetti-drift": p.drift,
                        "--confetti-delay": p.delay,
                        "--confetti-duration": p.duration,
                        "--confetti-spin": p.spin,
                      } as React.CSSProperties
                    }
                  />
                ))}
              </div>
              <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-[var(--accent)] text-[1.6rem] text-[var(--accent)] animate-scale-in">
                ✓
              </div>
              <p className="m-0 font-space-grotesk text-[1rem] font-bold text-[var(--accent)]">
                Transaction Successful
              </p>
              <p className="m-0 text-[0.75rem] text-[var(--muted)]">
                Fiat has been sent to your bank account
              </p>
            </div>
          )}

          {/* Error state */}
          {isError && error && (
            <div className="mt-5 flex flex-col items-center gap-3 py-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-red-500 text-[1.6rem] text-red-500">
                ✕
              </div>
              <p className="m-0 font-space-grotesk text-[1rem] font-bold text-red-400">
                Transaction Failed
              </p>
              <p className="m-0 max-w-[360px] text-center text-[0.75rem] text-[var(--muted)] break-words">
                {error}
              </p>
            </div>
          )}

          {/* Close button when done */}
          {isDone && onClose && (
            <button
              type="button"
              onClick={onClose}
              className="mt-4 w-full py-3 text-[0.8rem] font-bold uppercase tracking-[0.08em] transition-colors bg-[var(--accent)] text-[#0a0a0a] hover:brightness-110"
            >
              {isSuccess ? "DONE" : "CLOSE"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
