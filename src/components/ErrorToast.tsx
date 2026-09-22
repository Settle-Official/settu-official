"use client";

import { useEffect, useState } from "react";

interface ErrorToastProps {
  message: string | null;
  onDismiss: () => void;
}

export function ErrorToast({ message, onDismiss }: ErrorToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (message) {
      requestAnimationFrame(() => setVisible(true));
      const timer = setTimeout(() => {
        setVisible(false);
        setTimeout(onDismiss, 300);
      }, 6000);
      return () => clearTimeout(timer);
    } else {
      setVisible(false);
    }
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div
      className={`fixed top-4 left-1/2 z-[60] -translate-x-1/2 transition-all duration-300 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-3"
      }`}
    >
      <div className="racing-border-wrapper">
        <div className="racing-border-content flex items-start gap-3 px-5 py-4 min-w-[320px] max-w-[480px] max-[520px]:max-w-[90vw]">
          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-red-500 text-[0.8rem] text-red-500">
            ✕
          </div>
          <div className="flex flex-col gap-1">
            <p className="m-0 font-space-grotesk text-[0.82rem] font-bold text-red-400">
              TRANSACTION ERROR
            </p>
            <p className="m-0 font-mono text-[0.75rem] text-[var(--muted)] leading-relaxed">
              {message}
            </p>
          </div>
          <button
            type="button"
            onClick={() => { setVisible(false); setTimeout(onDismiss, 300); }}
            className="ml-2 flex-shrink-0 text-[var(--muted)] hover:text-[var(--foreground)] transition-colors leading-none"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
