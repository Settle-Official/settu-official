"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useStellarWallet } from "@/hooks/useStellarWallet";
import { useWalletBar } from "./WalletBar";
import { useAgentUnread } from "./AgentUnread";
import { useNotifications } from "./Notifications";
import {
  BellIcon,
  ChatIcon,
  CloseIcon,
  CurrencyIcon,
  DashboardIcon,
  HistoryIcon,
  MoneyIcon,
  QuestionIcon,
  SearchIcon,
  SidebarIcon,
} from "./icons";

export const APP_SECTIONS = [
  { href: "/app", label: "Dashboard", title: "Overview", icon: DashboardIcon },
  { href: "/app/offramp", label: "Offramp", title: "Offramp", icon: MoneyIcon },
  { href: "/app/onramp", label: "Onramp", title: "Onramp", icon: CurrencyIcon },
  { href: "/app/agent", label: "Agent", title: "Agent", icon: ChatIcon },
  { href: "/app/history", label: "History", title: "History", icon: HistoryIcon },
  { href: "/app/notifications", label: "Notification", title: "Notification", icon: BellIcon },
  { href: "/app/help", label: "Help", title: "Help", icon: QuestionIcon },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/app" ? pathname === "/app" : pathname.startsWith(href);
}

export function AppShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // Stellar is the default the bar shows; a screen with its own source
  // chain (offramp/agent) publishes that chain's wallet instead, so the
  // pill always reflects — and connects — the wallet actually in play.
  const stellar = useStellarWallet();
  const bar = useWalletBar();
  const active = bar.snapshot ?? {
    address: stellar.wallet?.publicKey,
    isConnected: stellar.isConnected,
    isConnecting: stellar.isConnecting,
  };
  const { isConnected, isConnecting } = active;
  const connect = bar.snapshot ? bar.connect : stellar.connect;
  const disconnect = bar.snapshot ? bar.disconnect : stellar.disconnect;
  // See AgentUnread.tsx: this is published by AgentPanel while it's mounted
  // and deliberately outlives it, so the badge still shows while the user
  // is on a different screen.
  const { count: agentUnread } = useAgentUnread();
  const { unreadCount: notificationUnread } = useNotifications();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const section = APP_SECTIONS.find((s) => isActive(pathname, s.href));
  const title = section?.title ?? "Overview";

  useEffect(() => setDrawerOpen(false), [pathname]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    router.push(q ? `/app/history?q=${encodeURIComponent(q)}` : "/app/history");
    setSearchOpen(false);
  };

  const walletLabel = isConnecting
    ? "Connecting…"
    : isConnected && active.address
      ? `${active.address.slice(0, 6)}…${active.address.slice(-6)}`
      : "Connect Wallet";

  const nav = (
    // Scrolls itself on a short viewport now that the shell is height-locked
    // and the page can no longer grow to reveal the lower items.
    <nav
      data-lenis-prevent
      className="flex min-h-0 flex-1 flex-col gap-[20px] overflow-y-auto overscroll-contain p-[20px]"
    >
      {APP_SECTIONS.map(({ href, label, icon: SectionIcon }) => {
        const active = isActive(pathname, href);
        const count =
          label === "Agent" ? agentUnread : label === "Notification" ? notificationUnread : 0;
        const badge = count > 0 ? (count > 9 ? "9+" : count) : null;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            title={collapsed ? label : undefined}
            className={`flex h-[63px] items-center gap-[10px] rounded-[10px] p-[20px] font-[family-name:var(--font-sora)] text-[18px] leading-[23px] text-white transition-colors hover:bg-[#242323]/70 ${
              active ? "bg-[#242323]" : ""
            } ${badge ? "justify-between" : ""} ${collapsed ? "justify-center px-0" : ""}`}
          >
            <span className="flex items-center gap-[10px]">
              <SectionIcon className="shrink-0 text-[#fbf9f9]" />
              {!collapsed && <span>{label}</span>}
            </span>
            {badge && !collapsed && (
              <span className="flex size-[30px] items-center justify-center rounded-full bg-[#f6f6f6] font-[family-name:var(--font-inter)] text-[14px] font-medium text-[#1a1a1a]">
                {badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  const brand = (
    <div className="flex h-[60px] items-center justify-between px-[20px] py-[10px]">
      {!collapsed && (
        <Link href="/app" className="font-[family-name:var(--font-inter)] text-[24px] font-semibold leading-[29px]">
          <span className="text-[#c9a962]">$</span>
          <span className="text-white">ETTU</span>
        </Link>
      )}
      <button
        type="button"
        onClick={() => {
          setCollapsed((c) => !c);
          setDrawerOpen(false);
        }}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="flex size-[40px] items-center justify-center rounded-[10px] text-[#cfcdcd] transition-colors hover:bg-[#242323]"
      >
        <SidebarIcon size={22} />
      </button>
    </div>
  );

  // The page itself never scrolls: the shell is locked to exactly the
  // viewport (h-screen, not min-h-screen, which would grow to fit content)
  // so the sidebar and header stay put and each screen's content scrolls
  // inside its own panel instead.
  const agentRoute = isActive(pathname, "/app/agent");

  return (
    <div className="flex h-screen overflow-hidden gap-[23px] bg-[#191818] px-[20px] pb-[20px] pt-[28px] max-[1100px]:gap-0 max-[1100px]:px-[12px] max-[1100px]:pt-[12px]">
      {/* Sidebar — sticky column on desktop, slide-in drawer below 1100px. */}
      <aside
        className={`sticky top-[28px] flex h-[calc(100vh-48px)] shrink-0 flex-col gap-[50px] self-start rounded-[20px] bg-[#1e1c1c] transition-[width] duration-300 max-[1100px]:hidden ${
          collapsed ? "w-[88px]" : "w-[264px]"
        }`}
      >
        {brand}
        {nav}
      </aside>
      {drawerOpen && (
        <div className="fixed inset-0 z-40 hidden max-[1100px]:block">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
            className="absolute inset-0 backdrop-blur-sm"
          />
          <aside className="absolute left-[12px] top-[12px] flex h-[calc(100vh-24px)] w-[264px] flex-col gap-[30px] rounded-[20px] bg-[#1e1c1c] shadow-[0_24px_48px_rgba(0,0,0,0.5)]">
            <div className="flex h-[60px] items-center justify-between px-[20px] py-[10px]">
              <span className="font-[family-name:var(--font-inter)] text-[24px] font-semibold leading-[29px]">
                <span className="text-[#c9a962]">$</span>
                <span className="text-white">ETTU</span>
              </span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
                className="flex size-[40px] items-center justify-center rounded-[10px] text-[#cfcdcd]"
              >
                <CloseIcon size={22} />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[28px] max-[1100px]:gap-[16px]">
        <header className="flex h-[94px] items-center justify-between gap-[20px] rounded-[20px] border border-white/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)] backdrop-blur-xl bg-white/10 px-[40px] py-[20px] max-[1100px]:h-auto max-[1100px]:flex-wrap max-[1100px]:px-[20px]">
          <div className="flex items-center gap-[14px]">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="hidden size-[40px] items-center justify-center rounded-[10px] text-[#cfcdcd] max-[1100px]:flex"
            >
              <SidebarIcon size={22} />
            </button>
            <h1 className="font-fraunces text-[28px] leading-[35px] text-white">{title}</h1>
          </div>

          <div className="flex items-center gap-[20px] max-[720px]:gap-[10px]">
            {searchOpen ? (
              <form onSubmit={submitSearch} className="flex items-center gap-[8px]">
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onBlur={() => !query && setSearchOpen(false)}
                  onKeyDown={(e) => e.key === "Escape" && setSearchOpen(false)}
                  placeholder="Search transactions…"
                  aria-label="Search transactions"
                  className="h-[50px] w-[260px] rounded-[25px] border border-white/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)] backdrop-blur-xl bg-[#c9a962]/20 px-[20px] font-[family-name:var(--font-inter)] text-[16px] text-white outline-none placeholder:text-white/50 max-[720px]:w-[160px]"
                />
              </form>
            ) : (
              // Inline backgrounds on the <button>s: globals.css has an
              // unlayered `button { background: none }` reset that beats any
              // layered bg-* utility (the bell, a link, is unaffected).
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                aria-label="Search transactions"
                style={{ backgroundColor: "rgba(201,169,98,0.2)" }}
                className="flex size-[50px] items-center justify-center rounded-full border border-white/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)] backdrop-blur-xl text-[#fbf9f9] transition-[filter] hover:brightness-150"
              >
                <SearchIcon size={22} />
              </button>
            )}
            <Link
              href="/app/notifications"
              aria-label={
                notificationUnread > 0
                  ? `Notifications, ${notificationUnread} unread`
                  : "Notifications"
              }
              className="relative flex size-[50px] items-center justify-center rounded-full border border-white/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)] backdrop-blur-xl bg-[#c9a962]/20 text-[#f4f1f1] transition-[filter] hover:brightness-150"
            >
              <BellIcon size={24} />
              {notificationUnread > 0 && (
                // A dot, not a count: the sidebar carries the number, and
                // this only has to say "there's something to look at".
                <span
                  aria-hidden="true"
                  style={{ backgroundColor: "#CA4C4C", border: "2px solid #241f1a" }}
                  className="absolute right-[10px] top-[10px] size-[11px] rounded-full"
                />
              )}
            </Link>
            <button
              type="button"
              onClick={isConnected ? disconnect : connect}
              disabled={isConnecting}
              title={isConnected ? "Disconnect wallet" : undefined}
              style={{ backgroundColor: "rgba(201,169,98,0.2)" }}
              className="flex h-[54px] min-w-[204px] items-center justify-center gap-[10px] rounded-[40px] border border-white/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)] backdrop-blur-xl px-[16px] font-[family-name:var(--font-inter)] text-[18px] text-white transition-[filter] hover:brightness-150 disabled:cursor-not-allowed disabled:opacity-60 max-[720px]:min-w-0 max-[720px]:text-[14px]"
            >
              {isConnected && <span className="size-[9px] rounded-full bg-[#61c85e]" />}
              {walletLabel}
            </button>
          </div>
        </header>

        {/* Agent Mode is a full-bleed chat surface with no card behind it
            (per its own design), unlike every other screen's translucent
            content card. */}
        {/* Every screen scrolls inside this panel, never the page. Agent
            Mode is the exception: its own message list does the scrolling
            so the composer can stay pinned, so the panel must not also be
            scrollable or the two would fight.
            data-lenis-prevent: the smooth-scroll library captures wheel
            events at the window, and without this it swallows them here —
            leaving a panel that only moves by dragging its scrollbar. */}
        <section
          data-lenis-prevent
          className={
            agentRoute
              ? "flex min-h-0 min-w-0 flex-1 flex-col p-[40px] max-[1100px]:p-[20px]"
              : "flex min-h-0 min-w-0 flex-1 flex-col gap-[30px] overflow-y-auto overscroll-contain rounded-[30px] bg-[rgba(83,79,79,0.2)] p-[40px] max-[1100px]:p-[20px]"
          }
        >
          {children}
        </section>
      </div>
    </div>
  );
}
