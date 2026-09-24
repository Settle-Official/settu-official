"use client";

import { useState } from "react";
import { useStellarWallet } from "@/hooks/useStellarWallet";
import { SettuLogo } from "@/components/brand/SettuLogo";

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
      // Inline: globals.css's unlayered `button { background: none }` reset
      // beats layered bg-* utilities.
      style={{ backgroundColor: "rgba(201,169,98,0.2)" }}
      className="flex h-[52px] w-[158px] items-center justify-center gap-[10px] rounded-[40px] border border-white/15 px-[16px] py-[16px] font-[family-name:var(--font-sora)] text-[16px] text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)] backdrop-blur-xl transition-[filter] hover:brightness-150 disabled:cursor-not-allowed disabled:opacity-60 max-[720px]:w-full"
    >
      {buttonLabel}
    </button>
  );

  return (
    <nav
      // Clears the status bar when installed to the home screen (see .app-shell).
      style={{ marginTop: "calc(20px + env(safe-area-inset-top, 0px))" }}
      className="relative z-10 mx-auto flex h-[72px] w-[890px] max-w-[calc(100%-32px)] items-center justify-between rounded-[40px] border border-white/15 bg-[#FFFFFF1A] py-[10px] px-[20px] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25),0_8px_32px_rgba(0,0,0,0.25)] backdrop-blur-xl max-[720px]:h-[70px] max-[720px]:max-w-[calc(100%-20px)]">
      {/* 120px wide on purpose: it balances the right-hand button so the
          centre links sit on the true centre. At 25px tall the lockup is
          98px wide, which fits with the padding. */}
      <div className="flex w-[120px] items-center p-[10px]">
        <SettuLogo className="h-[25px] w-auto" />
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
        {/* Three bars rather than two swapped icons: a swap has nothing to
            animate between, so the old version snapped. These rotate into
            the X. */}
        <span
          aria-hidden="true"
          className={`landing-burger ${menuOpen ? "is-open" : ""}`}
        >
          <span />
          <span />
          <span />
        </span>
      </button>
      {/* Always in the tree now — a panel that mounts and unmounts has no
          "from" state to transition out of, which is why it used to snap.
          The CSS keeps it inert and unfocusable while closed. */}
      <div
        id="landing-mobile-menu"
        className={`landing-menu-panel absolute left-0 right-0 top-[calc(100%+10px)] hidden rounded-[30px] border border-white/15 bg-[#121212]/95 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25),0_8px_32px_rgba(0,0,0,0.35)] backdrop-blur-xl max-[720px]:grid ${
          menuOpen ? "is-open" : ""
        }`}
      >
        <div>
          <div className="flex flex-col gap-[20px] p-[20px]">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                tabIndex={menuOpen ? undefined : -1}
                onClick={() => setMenuOpen(false)}
                className="font-[family-name:var(--font-sora)] text-[18px] leading-[23px] text-white"
              >
                {link.label}
              </a>
            ))}
            {connectButton}
          </div>
        </div>
      </div>
    </nav>
  );
}
