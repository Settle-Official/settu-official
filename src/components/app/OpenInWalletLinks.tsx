"use client";

import { useEffect, useState } from "react";
import { isMobileBrowser } from "@/lib/platform";
import { openInWalletLinks, type OpenInWalletLink } from "@/lib/evm/open-in-wallet";

/**
 * Under the connect button for EVM chains, on a phone, outside a wallet's own
 * browser: links that reopen this page inside MetaMask, Trust or Coinbase
 * Wallet, where connecting needs no WalletConnect relay. See open-in-wallet.ts.
 *
 * Decided after mount: the server can't know the device, and inside a wallet
 * browser (window.ethereum present) the connect button already works directly.
 */
export function OpenInWalletLinks() {
  const [links, setLinks] = useState<OpenInWalletLink[] | null>(null);

  useEffect(() => {
    const insideWallet = typeof (window as { ethereum?: unknown }).ethereum !== "undefined";
    if (!isMobileBrowser() || insideWallet) return;
    setLinks(openInWalletLinks(window.location.href));
  }, []);

  if (!links) return null;

  return (
    <div className="mt-[16px] flex flex-col items-center gap-[10px] text-center font-[family-name:var(--font-sora)]">
      <p className="text-[13px] leading-[18px] text-[#bdbcbc]">
        Can&apos;t connect on mobile data? Open Settu inside your wallet app:
      </p>
      <div className="flex flex-wrap justify-center gap-[8px]">
        {links.map((link) => (
          <a
            key={link.id}
            href={link.href}
            className="rounded-[20px] px-[14px] py-[8px] text-[13px] leading-[16px] text-white"
            style={{ border: "1px solid rgba(255,255,255,0.35)" }}
          >
            {link.name}
          </a>
        ))}
      </div>
    </div>
  );
}
