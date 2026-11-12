"use client";

import { useEffect, useState } from "react";
import { CloseIcon } from "@/components/app/icons";

interface ErrorToastProps {
  message: string | null;
  onDismiss: () => void;
}

// Long enough to read: some errors now carry steps (the mobile-data DNS fix),
// and six seconds isn't enough to take those in. Capped so it still goes away.
function displayMs(message: string): number {
  return Math.min(16_000, 6_000 + message.length * 40);
}

/**
 * The app-wide error toast, in the redesign's notice style: the same dark card
 * and muted red border as the onramp availability notice, with Sora type.
 */
export function ErrorToast({ message, onDismiss }: ErrorToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (message) {
      requestAnimationFrame(() => setVisible(true));
      const timer = setTimeout(() => {
        setVisible(false);
        setTimeout(onDismiss, 300);
      }, displayMs(message));
      return () => clearTimeout(timer);
    } else {
      setVisible(false);
    }
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div
      className={`fixed left-1/2 top-[max(16px,env(safe-area-inset-top))] z-[60] w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 transition-all duration-300 ${
        visible ? "translate-y-0 opacity-100" : "-translate-y-3 opacity-0"
      }`}
    >
      <div
        role="alert"
        // The same border as OnrampPanel's availability notice.
        style={{ border: "1px solid rgba(224,122,126,0.55)" }}
        className="flex items-start gap-[12px] rounded-[20px] bg-[#2b2a2a] px-[20px] py-[16px] shadow-[0_12px_32px_rgba(0,0,0,0.45)] max-[720px]:rounded-[14px] max-[720px]:px-[16px] max-[720px]:py-[14px]"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-[4px] font-[family-name:var(--font-sora)]">
          <p className="text-[15px] font-semibold leading-[21px] text-white max-[720px]:text-[14px] max-[720px]:leading-[20px]">
            Something went wrong
          </p>
          <p className="break-words text-[14px] leading-[21px] text-[#f1d6d7] max-[720px]:text-[13px] max-[720px]:leading-[19px]">
            {message}
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            setVisible(false);
            setTimeout(onDismiss, 300);
          }}
          className="-m-[6px] flex size-[32px] shrink-0 items-center justify-center rounded-full text-[#bdbcbc] transition-colors hover:text-white"
        >
          <CloseIcon size={18} />
        </button>
      </div>
    </div>
  );
}
