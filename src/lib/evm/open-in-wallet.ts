// Links that open a page inside an EVM wallet app's own browser.
//
// There the wallet talks to the page directly (an injected EIP-1193
// provider), so connecting never touches the WalletConnect relay. That is the
// way through for phones whose carrier blocks the relay: our relay proxy can
// carry Settu's side, but the wallet app's own relay connection is blocked
// too, and only it can fix that.
//
// Formats are each wallet's documented deep link for "open this dapp".

export interface OpenInWalletLink {
  readonly id: "metamask" | "trust" | "coinbase";
  readonly name: string;
  readonly href: string;
}

export function openInWalletLinks(pageUrl: string): OpenInWalletLink[] {
  const url = new URL(pageUrl);
  const full = `${url.origin}${url.pathname}${url.search}`;
  const withoutScheme = `${url.host}${url.pathname}${url.search}`;
  return [
    {
      id: "metamask",
      name: "MetaMask",
      href: `https://metamask.app.link/dapp/${withoutScheme}`,
    },
    {
      id: "trust",
      name: "Trust Wallet",
      href: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(full)}`,
    },
    {
      id: "coinbase",
      name: "Coinbase Wallet",
      href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(full)}`,
    },
  ];
}
