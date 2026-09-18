"use client";

import { useStellarWallet } from "@/hooks/useStellarWallet";

const NAV_LINKS = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Security", href: "#security" },
  { label: "FAQ", href: "#faq" },
  { label: "Support", href: "#support" },
];

export function Nav() {
  const { wallet, isConnected, isConnecting, connect, disconnect } = useStellarWallet();

  const buttonLabel = isConnecting
    ? "Connecting…"
    : isConnected && wallet?.publicKey
      ? `${wallet.publicKey.slice(0, 4)}...${wallet.publicKey.slice(-4)}`
      : "Connect Wallet";

  return (
    <nav className="mx-auto mt-[20px] flex w-[890px] max-w-[calc(100%-32px)] items-center justify-between rounded-[40px] border border-white/10 bg-[rgba(255,255,255,0.1)] px-[10px] py-[10px] backdrop-blur-md">
      <div className="flex w-[120px] items-center gap-[4px] p-[10px]">
        <span className="landing-fraunces text-[24px] font-semibold text-[#c9a962]">$</span>
        <span className="font-[family-name:var(--font-inter)] text-[24px] text-white">ETTU</span>
      </div>
      <div className="flex items-center gap-[50px]">
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
      <button
        type="button"
        onClick={isConnected ? disconnect : connect}
        disabled={isConnecting}
        className="rounded-[40px] border border-white/10 bg-[rgba(201,169,98,0.2)] px-[16px] py-[16px] font-[family-name:var(--font-sora)] text-[16px] text-white transition-colors hover:bg-[rgba(201,169,98,0.35)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {buttonLabel}
      </button>
    </nav>
  );
}
