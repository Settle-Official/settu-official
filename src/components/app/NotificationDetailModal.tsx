"use client";

import { useEffect, useRef } from "react";
import { CloseIcon } from "./icons";
import type { AppNotification, NotificationTone } from "./Notifications";

const TONE_COLOR: Record<NotificationTone, string> = {
  info: "#C9A962",
  success: "#109F21",
  failed: "#CA4C4C",
};

export function NotificationDetailModal({
  notification,
  onClose,
}: {
  readonly notification: AppNotification;
  readonly onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // The page behind is height-locked and scrolls inside its own panel, so
    // there is no body scroll to lock here — only the key handler to clean up.
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="notification-detail-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-[20px]"
    >
      <button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        style={{ backgroundColor: "rgba(0,0,0,0.7)" }}
        className="absolute inset-0 backdrop-blur-sm"
      />

      <div
        style={{ border: "1px solid rgba(255,255,255,0.15)" }}
        className="relative z-10 flex max-h-[80vh] w-full max-w-[560px] flex-col gap-[20px] rounded-[30px] bg-[#1e1c1c] p-[32px] shadow-[0_28px_60px_rgba(0,0,0,0.6)] max-[600px]:p-[22px]"
      >
        <div className="flex items-start justify-between gap-[16px]">
          <div className="flex min-w-0 items-start gap-[12px]">
            <span
              aria-hidden="true"
              style={{ backgroundColor: TONE_COLOR[notification.tone] }}
              className="mt-[10px] size-[10px] shrink-0 rounded-full"
            />
            <div className="flex min-w-0 flex-col gap-[4px]">
              <h2
                id="notification-detail-title"
                className="font-fraunces text-[24px] leading-[31px] text-white"
              >
                {notification.title}
              </h2>
              <span className="font-[family-name:var(--font-sora)] text-[13px] leading-[17px] text-[#8d8c8c]">
                {new Date(notification.timestamp).toLocaleString("en-GB", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-[36px] shrink-0 items-center justify-center rounded-full text-[#cfcdcd] transition-colors hover:text-white"
          >
            <CloseIcon size={18} />
          </button>
        </div>

        <p className="font-[family-name:var(--font-sora)] text-[16px] leading-[24px] text-[#d6d3d3]">
          {notification.body}
        </p>

        {notification.details.length > 0 && (
          // Scrolls itself: a failed transaction with a long error plus every
          // identifier can exceed the modal's height cap.
          <dl
            data-lenis-prevent
            // pr: keeps values clear of the scrollbar that appears when the
            // list is long enough to scroll.
            className="flex min-h-0 flex-col gap-[2px] overflow-y-auto overscroll-contain pr-[12px]"
          >
            {notification.details.map((d) => (
              <div
                key={d.label}
                style={{ borderTop: "1px solid #2b2929" }}
                className="flex items-baseline justify-between gap-[20px] py-[12px] max-[600px]:flex-col max-[600px]:gap-[4px]"
              >
                <dt className="shrink-0 font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-[#a19d9d]">
                  {d.label}
                </dt>
                <dd
                  className={`min-w-0 text-right font-[family-name:var(--font-sora)] text-[15px] leading-[22px] text-white max-[600px]:text-left ${
                    d.mono ? "break-all" : ""
                  }`}
                >
                  {d.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
