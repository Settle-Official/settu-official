/**
 * EIP-6963 (multi-injected provider discovery) + EIP-1193 helpers for
 * connecting a desktop browser-extension wallet directly, with no relay.
 * This is the counterpart to walletconnect-adapter.ts — that one is the
 * scan-from-your-phone path, this one is "you have MetaMask / Rabby /
 * Coinbase Wallet installed right here".
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on(event: string, listener: (...args: any[]) => void): void;
  removeListener(event: string, listener: (...args: any[]) => void): void;
}

export interface InjectedWalletInfo {
  /** EIP-6963 reverse-DNS id, e.g. "io.metamask" — stable, used as the key. */
  rdns: string;
  name: string;
  /** data: URI, per EIP-6963. */
  icon: string;
}

export interface InjectedWallet {
  info: InjectedWalletInfo;
  provider: Eip1193Provider;
}

interface Eip6963AnnounceEvent extends Event {
  detail: {
    info: { uuid: string; name: string; icon: string; rdns: string };
    provider: Eip1193Provider;
  };
}

/**
 * Fires the EIP-6963 request event and collects the wallets that announce
 * themselves within a short window. Falls back to a bare `window.ethereum`
 * (older wallets that predate 6963) when nothing announces.
 */
export function discoverInjectedWallets(timeoutMs = 350): Promise<InjectedWallet[]> {
  if (typeof window === "undefined") return Promise.resolve([]);

  return new Promise((resolve) => {
    const byRdns = new Map<string, InjectedWallet>();

    const onAnnounce = (event: Event) => {
      const { info, provider } = (event as Eip6963AnnounceEvent).detail;
      if (info?.rdns && provider) {
        byRdns.set(info.rdns, {
          info: { rdns: info.rdns, name: info.name, icon: info.icon },
          provider,
        });
      }
    };

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);

      if (byRdns.size === 0) {
        const legacy = (window as any).ethereum as Eip1193Provider | undefined;
        if (legacy) {
          byRdns.set("injected", {
            info: {
              rdns: "injected",
              name: (legacy as any).isMetaMask
                ? "MetaMask"
                : (legacy as any).isCoinbaseWallet
                  ? "Coinbase Wallet"
                  : "Browser Wallet",
              icon: "",
            },
            provider: legacy,
          });
        }
      }

      resolve([...byRdns.values()]);
    }, timeoutMs);
  });
}

export function toChainIdHex(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}
