"use client";

import type { ReactNode } from "react";
import { ArrowRightIcon, CheckIcon, CloseIcon } from "./icons";

/**
 * The terminal card both ramps end on — a tinted disc, a headline, a line of
 * explanation, and one outlined action below the card. Shared so the offramp
 * and onramp outcomes can't drift apart visually; the copy is entirely the
 * caller's.
 */
export function ResultCard({
  kind,
  title,
  body,
  actionLabel,
  onAction,
  compact = false,
}: {
  readonly kind: "success" | "failed";
  readonly title: string;
  readonly body: ReactNode;
  readonly actionLabel: string;
  readonly onAction: () => void;
  /** Inside an overlay, where the surrounding padding is the modal's. */
  readonly compact?: boolean;
}) {
  const isSuccess = kind === "success";
  return (
    <div className={`flex flex-col items-center max-[720px]:gap-[22px] max-[720px]:py-0 ${
        compact ? "gap-[28px] py-[4px]" : "gap-[50px] py-[60px] max-[720px]:gap-[30px]"
      }`}>
      <div className="flex w-[414px] max-w-full flex-col items-center gap-[24px] rounded-[20px] bg-[#232222] px-[30px] py-[40px] text-center max-[720px]:gap-[18px] max-[720px]:rounded-[14px] max-[720px]:px-[20px] max-[720px]:py-[32px]">
        <span
          className={`flex size-[82px] items-center justify-center rounded-full max-[720px]:size-[62px] ${
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
          <h2 className="font-fraunces text-[26px] leading-[32px] text-white max-[720px]:text-[20px] max-[720px]:leading-[26px]">
            {title}
          </h2>
          <p className="font-[family-name:var(--font-sora)] text-[18px] leading-[28px] text-[#e6e2e2] max-[720px]:text-[14px] max-[720px]:leading-[22px]">
            {body}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onAction}
        // Inline border: globals.css's unlayered `button { border: 0 }` reset
        // beats any layered border-* utility.
        style={{ border: "1px solid rgba(255,255,255,0.6)" }}
        className="flex h-[64px] w-[396px] max-w-full items-center justify-center gap-[10px] rounded-[40px] font-[family-name:var(--font-sora)] text-[18px] text-white transition-[filter] hover:brightness-125 hover:[background-color:rgba(255,255,255,0.06)] max-[720px]:h-[58px] max-[720px]:w-full max-[720px]:text-[16px]"
      >
        {actionLabel}
        <ArrowRightIcon size={20} className="max-[720px]:hidden" />
      </button>
    </div>
  );
}
