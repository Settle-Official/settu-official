"use client";

import { useEffect, useState } from "react";
import { enabledOfframpChainLabels } from "@/lib/cctp/evm-chains";

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} & ${items[items.length - 1]}`;
}

// Same announcement the header's marquee used to carry (reads the same
// NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED allowlist, so it never names a
// chain that isn't actually live) — a scrolling banner turned out easy to
// miss entirely, so this is a one-time popup instead. Computed at module
// load — build-time config.
const _offrampChains = enabledOfframpChainLabels();
const ANNOUNCEMENT =
  _offrampChains.length > 0
    ? `New — offramp your USDC straight from ${formatList(_offrampChains)}, on top of Stellar. Convert to your bank in minutes.`
    : "Settu is now available on mobile. You can add to home screen for easy access.";

// Bump this whenever the announcement's substance actually changes, so a
// returning user sees the new one instead of it staying dismissed forever
// under the old key.
const STORAGE_KEY = "settu_announcement_seen_v1";

/**
 * Shown once per browser on first landing — a blurred-backdrop popup rather
 * than the old scrolling marquee, which testing showed users could scroll
 * right past without ever reading.
 */
export function AnnouncementModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setOpen(true);
    } catch {
      // Private browsing / blocked storage: show it this load rather than
      // never at all — dismiss still won't persist, which is an acceptable
      // trade-off for a rare environment.
      setOpen(true);
    }
  }, []);

  const close = () => {
    setOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // Nothing to persist — it'll just show again next load.
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={close} />
      <div className="racing-border-wrapper relative z-10 w-[92vw] max-w-[420px]">
        <div className="racing-border-content p-6">
          <div className="mb-3 flex items-start justify-between gap-3">
            <h3 className="m-0 font-space-grotesk text-[1.05rem] font-bold tracking-[-0.02em] text-[#C9A962]">
              ANNOUNCEMENT
            </h3>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="text-[1.1rem] leading-none text-[var(--muted)] hover:text-white"
            >
              ✕
            </button>
          </div>
          <p className="m-0 text-[0.85rem] leading-relaxed text-[var(--foreground)]">
            {ANNOUNCEMENT}
          </p>
        </div>
      </div>
    </div>
  );
}
