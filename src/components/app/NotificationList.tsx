"use client";

import { useState } from "react";
import { NotificationDetailModal } from "./NotificationDetailModal";
import { useNotifications, type NotificationTone } from "./Notifications";

const TONE_COLOR: Record<NotificationTone, string> = {
  info: "#C9A962",
  success: "#109F21",
  failed: "#CA4C4C",
};

function when(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function NotificationList() {
  const { items, unreadCount, markAllRead, markAllUnread, markRead } = useNotifications();
  const [openId, setOpenId] = useState<string | null>(null);
  // Read from `items` rather than storing the notification itself, so the
  // open modal follows a change (marking it read) instead of showing a stale
  // copy of how it looked when it was clicked.
  const open = items.find((n) => n.id === openId) ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-[26px]">
      <div className="flex flex-wrap items-center justify-between gap-[16px]">
        <span className="font-[family-name:var(--font-sora)] text-[16px] leading-[20px] text-[#a19d9d]">
          {unreadCount > 0
            ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
            : "You're all caught up"}
        </span>

        {/* Inline styles: globals.css has an unlayered
            `button { background: none; border: 0 }` reset that beats the
            Tailwind border and background utilities here. */}
        <div className="flex flex-wrap items-center gap-[12px]">
          <button
            type="button"
            onClick={markAllRead}
            disabled={unreadCount === 0}
            style={{ border: "1px solid #D7D6D6" }}
            className="flex h-[50px] items-center rounded-[20px] px-[20px] font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-[#e6e3e3] transition-[filter] hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Mark all as read
          </button>
          <button
            type="button"
            onClick={markAllUnread}
            disabled={unreadCount === items.length}
            style={{ border: "1px solid #D7D6D6" }}
            className="flex h-[50px] items-center rounded-[20px] px-[20px] font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-[#e6e3e3] transition-[filter] hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Mark all as unread
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="py-[28px] font-[family-name:var(--font-sora)] text-[16px] text-[#bab6b6]">
          No notifications yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-[12px]">
          {items.map((n) => (
            <li key={n.id}>
              {/* The whole row opens the detail view, and seeing it counts as
                  reading it — so there is no separate "mark read" control. */}
              <button
                type="button"
                onClick={() => {
                  setOpenId(n.id);
                  markRead(n.id);
                }}
                aria-haspopup="dialog"
                aria-label={`${n.title} — open details`}
                style={{
                  backgroundColor: n.read ? "rgba(127,125,125,0.06)" : "rgba(201,169,98,0.10)",
                  border: n.read ? "1px solid transparent" : "1px solid rgba(201,169,98,0.28)",
                }}
                className="flex w-full items-start gap-[14px] rounded-[20px] p-[20px] text-left transition-[filter] hover:brightness-125"
              >
                <span
                  aria-hidden="true"
                  style={{ backgroundColor: TONE_COLOR[n.tone], opacity: n.read ? 0.35 : 1 }}
                  className="mt-[7px] size-[9px] shrink-0 rounded-full"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-[6px]">
                  <span className="flex flex-wrap items-baseline justify-between gap-[10px]">
                    <span
                      className={`font-fraunces text-[18px] leading-[24px] ${
                        n.read ? "text-[#cfcdcd]" : "text-white"
                      }`}
                    >
                      {n.title}
                    </span>
                    <span className="font-[family-name:var(--font-sora)] text-[13px] leading-[17px] text-[#8d8c8c]">
                      {when(n.timestamp)}
                    </span>
                  </span>
                  <span
                    className={`font-[family-name:var(--font-sora)] text-[15px] leading-[22px] ${
                      n.read ? "text-[#a19d9d]" : "text-[#d6d3d3]"
                    }`}
                  >
                    {n.body}
                  </span>
                </span>
                {!n.read && (
                  <span className="shrink-0 rounded-full bg-[#c9a962]/20 px-[10px] py-[4px] font-[family-name:var(--font-inter)] text-[11px] font-medium uppercase tracking-[0.06em] text-[#e6cf95]">
                    New
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && <NotificationDetailModal notification={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}
