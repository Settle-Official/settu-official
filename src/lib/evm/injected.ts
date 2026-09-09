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

function legacyInjectedWallet(): InjectedWallet | null {
  const legacy = (window as any).ethereum as Eip1193Provider | undefined;
  if (!legacy) return null;
  return {
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
  };
}

/**
 * Subscribes to EIP-6963 announcements and keeps calling `onChange` with the
 * full deduped list as wallets show up. Wallets can announce at any time
 * (some are slow, some re-announce), so this stays subscribed rather than
 * resolving once. Returns an unsubscribe plus a `refresh()` that re-fires the
 * request event. Also seeds a legacy `window.ethereum` immediately.
 */
export function subscribeInjectedWallets(
  onChange: (wallets: InjectedWallet[]) => void,
): { unsubscribe: () => void; refresh: () => void } {
  if (typeof window === "undefined") {
    return { unsubscribe: () => {}, refresh: () => {} };
  }

  const byRdns = new Map<string, InjectedWallet>();
  const emit = () => onChange([...byRdns.values()]);

  const onAnnounce = (event: Event) => {
    const { info, provider } = (event as Eip6963AnnounceEvent).detail;
    if (info?.rdns && provider) {
      byRdns.set(info.rdns, {
        info: { rdns: info.rdns, name: info.name, icon: info.icon },
        provider,
      });
      // A real 6963 wallet supersedes the bare-window.ethereum placeholder.
      byRdns.delete("injected");
      emit();
    }
  };

  window.addEventListener("eip6963:announceProvider", onAnnounce);

  const refresh = () => {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // If nothing has announced shortly after, fall back to window.ethereum.
    setTimeout(() => {
      if (byRdns.size === 0) {
        const legacy = legacyInjectedWallet();
        if (legacy) {
          byRdns.set(legacy.info.rdns, legacy);
          emit();
        }
      }
    }, 400);
  };

  refresh();

  return {
    unsubscribe: () => window.removeEventListener("eip6963:announceProvider", onAnnounce),
    refresh,
  };
}

export function toChainIdHex(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}
