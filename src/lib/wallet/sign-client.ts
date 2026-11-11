// One WalletConnect SignClient for every chain that pairs directly, on storage
// of its own.
//
// AppKit runs a second WalletConnect core for Solana. Left on the default
// "wc@2:core" prefix both cores share one keychain and subscribe to the same
// topics, so a response can reach the instance that can't decrypt it — which
// surfaces as "onRelayMessage() -> failed to process an inbound message" and a
// signature that never arrives.

import { SignClient } from "@walletconnect/sign-client";

// Changing this orphans existing sessions: they live under the old prefix.
const STORAGE_PREFIX = "settu";

// A relay that accepts the WebSocket but cannot carry a message leaves
// connect() pending forever rather than rejecting. Bounded so that surfaces as
// an error the user can act on instead of a button stuck on "connecting".
const PAIRING_TIMEOUT_MS = 20_000;

let clientPromise: ReturnType<typeof SignClient.init> | null = null;

type Client = Awaited<ReturnType<typeof SignClient.init>>;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () =>
          reject(
            // Leads with the workaround that actually works on cellular: an
            // in-app browser injects its provider and needs no relay at all.
            new Error(
              "Couldn't reach the WalletConnect network — some mobile carriers " +
                "block it on cellular data. Open settu.xyz inside your wallet's " +
                "own browser (MetaMask, Trust, Coinbase Wallet) and it will " +
                "connect directly. Wi-Fi works too, as does turning off a VPN " +
                "or iCloud Private Relay.",
            ),
          ),
        ms,
      ),
    ),
  ]);
}

/**
 * Pairs through the shared client, bounded, and drops that client if it fails.
 *
 * The cached client is the reason a failure used to be permanent: once its
 * socket is wedged, every later attempt reuses it and hangs with no error at
 * all. Clearing it means the next try builds a fresh connection.
 */
export async function createPairing<T>(
  propose: (client: Client) => Promise<T>,
): Promise<T> {
  try {
    const client = await withTimeout(getSignClient(), PAIRING_TIMEOUT_MS);
    return await withTimeout(propose(client), PAIRING_TIMEOUT_MS);
  } catch (error) {
    clientPromise = null;
    throw error;
  }
}

export function getSignClient() {
  if (!clientPromise) {
    const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    if (!projectId) {
      throw new Error("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is missing");
    }
    const origin =
      typeof window !== "undefined" ? window.location.origin : "https://settu.xyz";
    // Where the wallet sends the user back. It has to be the page that holds
    // the pairing: the origin alone is the landing page, and returning there
    // tears down the /app screen waiting for the response.
    const returnTo =
      typeof window !== "undefined"
        ? `${origin}${window.location.pathname}`
        : origin;
    clientPromise = SignClient.init({
      projectId,
      customStoragePrefix: STORAGE_PREFIX,
      metadata: {
        name: "Settu",
        description: "Convert USDC to your bank account in minutes.",
        url: origin,
        icons: [`${origin}/icons/icon-192.png`],
        // Without this the wallet has no way to hand its response back: the
        // user approves, the wallet reports success, and the signature is
        // dropped on the relay. Confirmed against Freighter on mobile.
        redirect: { native: "", universal: returnTo },
      },
    });
  }
  return clientPromise;
}
