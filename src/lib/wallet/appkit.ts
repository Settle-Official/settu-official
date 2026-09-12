// The one Reown AppKit instance for the whole app.
//
// It must be exactly one. AppKit guards modal mounting with a MODULE-LEVEL
// flag:
//
//     let isInitialized = false;
//     if (!isInitialized) { ...insert <w3m-modal>...; isInitialized = true; }
//
// so only the first createAppKit call ever mounts an element, while every
// instance shares the same controllers. A second instance therefore has no
// modal of its own: its open() mutates state that renders the first
// instance's element, configured for the first instance's chains. The sheet
// shows the wrong wallets or nothing at all, and the caller waits on an
// approval that can never arrive — which is why Stellar and Solana hung while
// EVM, whose instance happened to be created first, worked.
//
// Every chain therefore connects through here. Solana uses the adapter
// directly; chains that pair with their own SignClient (Stellar via
// stellar-wallets-kit, EVM via ours) hand their `wc:` URI to openSheet.

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
        // One sheet serves all three chains, so this row is cross-chain. Left
        // to the registry's own ranking it leads with Trust, Binance and
        // SafePal and buries Phantom and Freighter behind a search. Solana
        // connects additionally pass namespace: "solana", which filters the
        // full list properly; a raw pairing URI carries no namespace, so
        // Stellar and EVM rely on this row plus search.
        //
        // IDs come from the WalletConnect Explorer API, not guessed.
        featuredWalletIds: [
          "a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393", // Phantom   (Solana)
          "997a355c8f682468706a76cff1b004a7115f505fb962dac54b6e9b442dd1c380", // Freighter (Stellar)
          "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96", // MetaMask  (EVM)
          "1ca0bdd4747578705b1939af023d120677c64fe6ca76add81fda36e350605e79", // Solflare  (Solana)
          "76a3d548a08cf402f5c7d021f24fd2881d767084b387a5325df88bc3d4b6f21b", // LOBSTR    (Stellar)
          "4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0", // Trust     (EVM)
        ],
        features: { analytics: false, email: false, socials: false },
      } as never) as never;
    })();
  }
  return kitPromise;
}

/**
 * Presents an existing WalletConnect pairing URI in the shared sheet, for
 * chains that do their own pairing. Returns false if AppKit is unavailable, so
 * the caller can fall back rather than hang.
 */
export async function openSheet(uri: string): Promise<boolean> {
  try {
    const kit = await getKit();
    await (kit as unknown as { open: (o: { uri: string }) => Promise<void> }).open({ uri });
    return true;
  } catch {
    return false;
  }
}

export async function closeSheet(): Promise<void> {
  try {
    const kit = await getKit();
    await kit.close();
  } catch {
    // Nothing open, or AppKit never initialised.
  }
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

/** Ensures the shared instance exists before anything else can create one. */
export async function warmSharedAppKit(): Promise<void> {
  try {
    await getKit();
  } catch {
    // No project id, or AppKit failed to load — connect() reports the real error.
  }
}
