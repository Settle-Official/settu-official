"use client";

import { useState } from "react";
import { useStellarWallet } from "@/hooks/useStellarWallet";

const NAV_LINKS = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Security", href: "#security" },
  { label: "FAQ", href: "#faq" },
  { label: "Support", href: "#support" },
];

export function Nav() {
  const { wallet, isConnected, isConnecting, connect, disconnect } = useStellarWallet();
  const [menuOpen, setMenuOpen] = useState(false);

  const buttonLabel = isConnecting
    ? "Connecting…"
    : isConnected && wallet?.publicKey
      ? `${wallet.publicKey.slice(0, 4)}...${wallet.publicKey.slice(-4)}`
      : "Connect Wallet";

  const connectButton = (
    <button
      type="button"
      onClick={isConnected ? disconnect : connect}
      disabled={isConnecting}
      className="flex h-[52px] w-[158px] items-center justify-center gap-[10px] rounded-[40px] border border-white/15 bg-[#C9A96233] px-[16px] py-[16px] font-[family-name:var(--font-sora)] text-[16px] text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)] backdrop-blur-xl transition-colors hover:bg-[#C9A96255] disabled:cursor-not-allowed disabled:opacity-60 max-[720px]:w-full"
    >
      {buttonLabel}
    </button>
  );

  return (
    <nav className="relative z-10 mx-auto mt-[20px] flex h-[72px] w-[890px] max-w-[calc(100%-32px)] items-center justify-between rounded-[40px] border border-white/15 bg-[#FFFFFF1A] py-[10px] px-[20px] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25),0_8px_32px_rgba(0,0,0,0.25)] backdrop-blur-xl max-[720px]:h-[70px] max-[720px]:max-w-[calc(100%-20px)]">
      <div className="flex w-[120px] items-center gap-[4px] p-[10px]">
        <span className="landing-fraunces text-[24px] font-semibold text-[#c9a962]">$</span>
        <span className="font-[family-name:var(--font-inter)] text-[24px] text-white">ETTU</span>
      </div>
      <div className="flex items-center gap-[50px] max-[720px]:hidden">
        {NAV_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="font-[family-name:var(--font-sora)] text-[18px] text-white transition-colors hover:text-[#c9a962]"
          >
            {link.label}
          </a>
        ))}
      </div>
      <div className="max-[720px]:hidden">{connectButton}</div>

      {/* Phone: the link row is replaced by a menu button (Figma marks the
          row `hidden` and puts a list icon in its place); the links and the
          wallet button live in a sheet under the bar. */}
      <button
        type="button"
        aria-label={menuOpen ? "Close menu" : "Open menu"}
        aria-expanded={menuOpen}
        aria-controls="landing-mobile-menu"
        onClick={() => setMenuOpen((open) => !open)}
        className="hidden size-[44px] items-center justify-center text-[#eeeaea] max-[720px]:flex"
      >
        <svg width={24} height={24} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {menuOpen ? (
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
          ) : (
            <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
          )}
        </svg>
      </button>
      {menuOpen && (
        <div
          id="landing-mobile-menu"
          className="absolute left-0 right-0 top-[calc(100%+10px)] hidden flex-col gap-[20px] rounded-[30px] border border-white/15 bg-[#121212]/95 p-[20px] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25),0_8px_32px_rgba(0,0,0,0.35)] backdrop-blur-xl max-[720px]:flex"
        >
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
              className="font-[family-name:var(--font-sora)] text-[18px] leading-[23px] text-white"
            >
              {link.label}
            </a>
          ))}
          {connectButton}
        </div>
      )}
    </nav>
  );
}
