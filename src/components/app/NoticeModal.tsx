"use client";

import { useEffect, useState } from "react";
import { isMobileBrowser } from "@/lib/platform";
import { CloseIcon } from "./icons";
import { NOTICE } from "./NoticeBanner";

// Once per browser session, keyed by the notice text so a new notice shows
// even to someone who dismissed the previous one.
const SEEN_KEY = "settu:notice-seen";

/**
 * NOTICE as a popup, for phones and tablets arriving at /app. The banner
 * scrolls past too quickly to read on a small screen, and the notice is
 * usually about something that happens on phones (mobile data blocking
 * wallet connections). Closes on the close button, a tap outside the card, or
 * Escape.
 */
export function NoticeModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!NOTICE || !isMobileBrowser()) return;
    try {
      if (sessionStorage.getItem(SEEN_KEY) === NOTICE) return;
    } catch {
      // Storage blocked: show it; it just can't be remembered.
    }
    setOpen(true);
  }, []);

  const close = () => {
    setOpen(false);
    try {
      if (NOTICE) sessionStorage.setItem(SEEN_KEY, NOTICE);
    } catch {
      // Nothing to remember it in; it shows again next load.
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open || !NOTICE) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="notice-modal-title"
      className="fixed inset-0 z-[70] flex items-center justify-center p-[16px]"
    >
      <button
        type="button"
        aria-label="Close notice"
        onClick={close}
        style={{ backgroundColor: "rgba(0,0,0,0.7)" }}
        className="absolute inset-0 backdrop-blur-sm"
      />
      <div className="relative z-10 flex w-full max-w-[420px] flex-col gap-[14px] rounded-[20px] bg-[#232222] px-[24px] pb-[28px] pt-[24px] max-[720px]:rounded-[14px] max-[720px]:px-[20px] max-[720px]:pb-[24px]">
        <div className="flex items-start justify-between gap-[12px]">
          <h2
            id="notice-modal-title"
            className="font-fraunces text-[24px] leading-[30px] text-white max-[720px]:text-[20px] max-[720px]:leading-[26px]"
          >
            Notice
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="-m-[6px] flex size-[36px] shrink-0 items-center justify-center rounded-full text-[#bdbcbc] transition-colors hover:text-white"
          >
            <CloseIcon size={20} />
          </button>
        </div>
        <p className="font-[family-name:var(--font-sora)] text-[15px] leading-[24px] text-[#e6e2e2] max-[720px]:text-[14px] max-[720px]:leading-[22px]">
          {NOTICE}
        </p>
      </div>
    </div>
  );
}
