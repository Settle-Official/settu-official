// Solana wallet connection via Reown AppKit.
//
// Wallet Standard alone only ever registers browser extensions, which do not
// exist on a phone — mobile users saw an empty picker and had no way to
// connect. AppKit lists wallets from the WalletConnect registry, deep-links
// into them on mobile and falls back to a QR on desktop, which is the same
// mechanism Stellar and EVM already use here.
//
// Its Solana adapter connects over WalletConnect on mobile, so signing goes
// through the AppKit provider rather than Wallet Standard's features.

const SOLANA_NAMESPACE = "solana" as const;

/** The subset of AppKit's Solana provider this app uses. */
export interface SolanaProvider {
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signAndSendTransaction(transaction: unknown): Promise<{ signature: string }>;
}

type Kit = {
  open: (options?: { view?: string; namespace?: string }) => Promise<void>;
  close: () => Promise<void>;
  disconnect: (namespace?: string) => Promise<void>;
  getAddress: (namespace?: string) => string | undefined;
  getProvider: <T>(namespace: string) => T | undefined;
  subscribeAccount: (
    callback: (state: { address?: string; isConnected: boolean }) => void,
    namespace?: string,
  ) => () => void;
};

let kitPromise: Promise<Kit> | null = null;

// Dynamic import: AppKit touches `window` at module scope and would break
// Next's server prerender.
async function getKit(): Promise<Kit> {
  if (!kitPromise) {
    kitPromise = (async () => {
      const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
      if (!projectId) {
        throw new Error("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is missing");
      }
      const [{ createAppKit }, { solana }, { SolanaAdapter }] = await Promise.all([
        import("@reown/appkit"),
        import("@reown/appkit/networks"),
        import("@reown/appkit-adapter-solana"),
      ]);
      const origin = window.location.origin;
      return createAppKit({
        projectId,
        adapters: [new SolanaAdapter()],
        networks: [solana],
        metadata: {
          name: "Settu",
          description: "Convert USDC to your bank account in minutes.",
          url: origin,
          icons: [`${origin}/icons/icon-192.png`],
        },
        features: { analytics: false, email: false, socials: false },
      } as never) as never;
    })();
  }
  return kitPromise;
}

/** Opens the wallet picker. Resolves once a wallet connects, or rejects. */
export async function connectSolana(): Promise<string> {
  const kit = await getKit();

  const existing = kit.getAddress(SOLANA_NAMESPACE);
  if (existing) return existing;

  await kit.open({ namespace: SOLANA_NAMESPACE });

  // AppKit's modal has no "await the connection" API, so resolve off the
  // account subscription and let a closed modal without a connection reject.
  return new Promise<string>((resolve, reject) => {
    const unsubscribe = kit.subscribeAccount((state) => {
      if (state.isConnected && state.address) {
        unsubscribe();
        resolve(state.address);
      }
    }, SOLANA_NAMESPACE);

    // Bounded so a dismissed sheet doesn't leave the caller waiting forever —
    // the failure mode that made the old connect button stick on "connecting".
    setTimeout(() => {
      unsubscribe();
      const address = kit.getAddress(SOLANA_NAMESPACE);
      if (address) resolve(address);
      else reject(new Error("Connection cancelled."));
    }, 180_000);
  });
}

export async function disconnectSolana(): Promise<void> {
  const kit = await getKit();
  await kit.disconnect(SOLANA_NAMESPACE);
}

export async function getSolanaAddress(): Promise<string | undefined> {
  const kit = await getKit();
  return kit.getAddress(SOLANA_NAMESPACE);
}

export async function getSolanaProvider(): Promise<SolanaProvider> {
  const kit = await getKit();
  const provider = kit.getProvider<SolanaProvider>(SOLANA_NAMESPACE);
  if (!provider) throw new Error("No Solana wallet connected");
  return provider;
}

/** Follows connect/disconnect that happen inside AppKit's own UI. */
export async function subscribeSolanaAccount(
  callback: (address: string | null) => void,
): Promise<() => void> {
  const kit = await getKit();
  return kit.subscribeAccount(
    (state) => callback(state.isConnected && state.address ? state.address : null),
    SOLANA_NAMESPACE,
  );
}
