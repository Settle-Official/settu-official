"use client";

import type { OfframpStep } from "@/components/TransactionProgressModal";
import { ArrowRightIcon, CheckIcon, CloseIcon } from "./icons";

const STEP_KEYS: OfframpStep[] = [
  "initiating",
  "awaiting-signature",
  "submitting",
  "processing",
  "settling",
];

export interface OfframpReceipt {
  /** Fiat the beneficiary receives, already formatted with its symbol (₦3,000). */
  readonly fiat: string;
  readonly bankName: string;
  readonly accountNumber: string;
}

export interface OfframpStatusPanelProps {
  readonly step: OfframpStep;
  readonly error?: string | null;
  /** Where the flow stopped — "error" itself carries no position. */
  readonly failedAtStep?: OfframpStep;
  readonly sourceChainLabel: string;
  readonly receipt: OfframpReceipt | null;
  /** Bail out while the flow is waiting on the wallet. */
  readonly onCancel?: () => void;
  /** Leave the done/failed card: back to the form. */
  readonly onClose: () => void;
  readonly onViewTransaction: () => void;
}

/**
 * The offramp flow's in-page states — processing steps, done, failed —
 * rendered in place of the form (the design replaces the form rather than
 * overlaying a modal).
 */
export function OfframpStatusPanel({
  step,
  error,
  failedAtStep,
  sourceChainLabel,
  receipt,
  onCancel,
  onClose,
  onViewTransaction,
}: OfframpStatusPanelProps) {
  const isSuccess = step === "success";
  const isError = step === "error";
  const activeIndex = STEP_KEYS.indexOf(
    isError ? (failedAtStep ?? "idle") : step,
  );
  const canCancel =
    !!onCancel && (step === "awaiting-signature" || step === "submitting");

  const steps = [
    "Initiating Offramp",
    "Confirm transaction in wallet",
    `Submitting on ${sourceChainLabel}`,
    "Transaction processing",
    "Confirming settlement in fiat",
  ];

  if (isSuccess || isError) {
    return (
      <div className="flex flex-col items-center gap-[50px] py-[60px]">
        <div className="flex w-[414px] max-w-full flex-col items-center gap-[24px] rounded-[20px] bg-[#232222] px-[30px] py-[40px] text-center">
          <span
            className={`flex size-[82px] items-center justify-center rounded-full ${
              isSuccess ? "bg-[#2fb457]" : "bg-[#b23a3e]"
            }`}
          >
            {isSuccess ? (
              <CheckIcon size={40} strokeWidth={2.4} className="text-white" />
            ) : (
              <CloseIcon size={36} strokeWidth={2.4} className="text-white" />
            )}
          </span>
          <div className="flex flex-col gap-[12px]">
            <h2 className="font-fraunces text-[26px] leading-[32px] text-white">
              {isSuccess
                ? `Done — ${receipt?.fiat ?? "your money"} is on its way`
                : "Oops! Transaction failed"}
            </h2>
            <p className="font-[family-name:var(--font-sora)] text-[18px] leading-[28px] text-[#e6e2e2]">
              {isSuccess
                ? receipt
                  ? `Sent to ${receipt.bankName} •••• ${receipt.accountNumber.slice(-3)}. It usually lands within minutes.`
                  : "It usually lands within minutes."
                : error ||
                  "The transaction was cancelled during the initiating process"}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={isSuccess ? onViewTransaction : onClose}
          // Inline border: globals.css's unlayered `button { border: 0 }` reset
          // beats any layered border-* utility.
          style={{ border: "1px solid rgba(255,255,255,0.6)" }}
          className="flex h-[64px] w-[396px] max-w-full items-center justify-center gap-[10px] rounded-[40px] font-[family-name:var(--font-sora)] text-[18px] text-white transition-[filter] hover:brightness-125 hover:[background-color:rgba(255,255,255,0.06)]"
        >
          {isSuccess ? "View Transaction" : "Try again"}
          <ArrowRightIcon size={20} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-[50px] py-[60px]">
      <div className="flex w-[398px] max-w-full flex-col gap-[28px] rounded-[20px] bg-[#232222] px-[24px] py-[28px]">
        <h2 className="font-[family-name:var(--font-sora)] text-[18px] leading-[23px] text-white">
          Processing Offramp
        </h2>
        <ol className="flex flex-col">
          {steps.map((label, i) => {
            const done = activeIndex > i;
            const current = activeIndex === i;
            const last = i === steps.length - 1;
            return (
              <li key={label} className="flex gap-[14px]">
                <div className="flex flex-col items-center">
                  <span
                    className={`flex size-[24px] shrink-0 items-center justify-center rounded-full border ${
                      done
                        ? "border-[#c9a962] bg-[#c9a962] text-[#1a1a1a]"
                        : current
                          ? "landing-offramp-spin border-dashed border-white"
                          : "border-[#6a6969]"
                    }`}
                  >
                    {done && <CheckIcon size={13} strokeWidth={2.6} />}
                  </span>
                  {!last && (
                    <span className="my-[4px] w-px flex-1 bg-[#4d4c4c]" />
                  )}
                </div>
                <span
                  className={`pb-[26px] font-[family-name:var(--font-sora)] text-[15px] leading-[24px] ${
                    done
                      ? "text-[#c9a962]"
                      : current
                        ? "text-white"
                        : "text-[#8d8c8c]"
                  }`}
                >
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      {canCancel && (
        <button
          type="button"
          onClick={onCancel}
          style={{ border: "1px solid rgba(255,255,255,0.6)" }}
          className="flex h-[64px] w-[396px] max-w-full items-center justify-center gap-[8px] rounded-[40px] font-[family-name:var(--font-sora)] text-[18px] text-[#e07a7e] transition-[filter] hover:brightness-125 hover:[background-color:rgba(255,255,255,0.06)]"
        >
          Cancel
          <CloseIcon size={16} />
        </button>
      )}
    </div>
  );
}
