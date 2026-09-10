// Getting a Solana wallet on mobile web.
//
// Solana wallets are discovered through Wallet Standard, which only registers
// browser extensions — none exist on a phone, so a mobile browser finds no
// wallets at all and the picker is empty. There is no WalletConnect equivalent
// with broad Solana support to fall back on.
//
// The established route is to reopen the site inside the wallet's own in-app
// browser, where its provider is injected and Wallet Standard works normally.
//
// Templates are from each wallet's official deeplink documentation
// (docs.phantom.com, docs.solflare.com). Both parameters must be URL-encoded.

export interface SolanaMobileWallet {
  name: string;
  /** Opens the current page inside that wallet's in-app browser. */
  href: (currentUrl: string) => string;
}

export const SOLANA_MOBILE_WALLETS: SolanaMobileWallet[] = [
  {
    name: "Phantom",
    href: (url) =>
      `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(origin(url))}`,
  },
  {
    name: "Solflare",
    href: (url) =>
      `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(origin(url))}`,
  },
];

// `ref` identifies the requesting app; fall back to the full URL if it can't be parsed.
function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
