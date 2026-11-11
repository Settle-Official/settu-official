// One WalletConnect SignClient for every chain that pairs directly, on storage
// of its own.
//
// AppKit runs a second WalletConnect core for Solana. Left on the default
// "wc@2:core" prefix both cores share one keychain and subscribe to the same
// topics, so a response can reach the instance that can't decrypt it — which
// surfaces as "onRelayMessage() -> failed to process an inbound message" and a
// signature that never arrives.

import { SignClient } from "@walletconnect/sign-client";
import { enableRelayProxy, isRelayProxyEnabled } from "./relay-proxy";

// Changing this orphans existing sessions: they live under the old prefix.
const STORAGE_PREFIX = "settu";

// A relay that accepts the WebSocket but cannot carry a message, or that the
// network blocks outright, leaves connect() pending forever rather than
// rejecting. Bounded so it surfaces as an error.
//
// The direct attempt is kept short because a blocked carrier never answers,
// and we have the proxy to fall back to. The proxied attempt gets longer: it
// is the last resort, and it adds a hop.
const DIRECT_TIMEOUT_MS = 10_000;
const PROXY_TIMEOUT_MS = 20_000;

const UNREACHABLE_MESSAGE =
  "Couldn't reach the WalletConnect network. Check your connection and try " +
  "again — if you're on mobile data, try Wi-Fi.";

let clientPromise: ReturnType<typeof SignClient.init> | null = null;

type Client = Awaited<ReturnType<typeof SignClient.init>>;

class RelayTimeoutError extends Error {
  constructor() {
    super(UNREACHABLE_MESSAGE);
    this.name = "RelayTimeoutError";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RelayTimeoutError()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Drops the shared client and shuts its socket for good.
 *
 * Only forgetting it isn't enough. A forgotten client keeps its socket, and on
 * the next network change (switching to Wi-Fi, say) WalletConnect reconnects it.
 * It then shares storage and topics with the fresh client, and can take the
 * wallet's approval meant for that one, which the user sees as an approval
 * that never lands.
 */
function discardClient(): void {
  const dead = clientPromise;
  clientPromise = null;
  dead
    ?.then(async (client) => {
      const relayer = client.core.relayer as unknown as {
        transportOpen: (...args: unknown[]) => Promise<void>;
      };
      // Reconnects go through transportOpen; make it a no-op on this one.
      relayer.transportOpen = async () => {};
      await client.core.relayer.transportClose();
    })
    .catch(() => {});
}

// Where the wallet sends the user back. It has to be the page holding the
// pairing: the origin alone is the landing page, and returning there tears
// down the /app screen waiting for the response. Read per connect, because the
// client outlives the page it was created on.
function returnTarget(): string {
  if (typeof window === "undefined") return "https://settu.xyz";
  return `${window.location.origin}${window.location.pathname}`;
}

async function attempt<T>(
  propose: (client: Client) => Promise<T>,
  ms: number,
): Promise<T> {
  try {
    const client = await withTimeout(getSignClient(), ms);
    client.metadata.redirect = { native: "", universal: returnTarget() };
    return await withTimeout(propose(client), ms);
  } catch (error) {
    discardClient();
    throw error;
  }
}

/**
 * Pairs through the shared client, bounded, and drops that client if it fails.
 *
 * If the relay can't be reached directly, the device switches to the relay
 * proxy on our own domain (relay-proxy.ts) and tries once more. That choice is
 * remembered, so later page loads start on the proxy.
 */
export async function createPairing<T>(
  propose: (client: Client) => Promise<T>,
): Promise<T> {
  if (isRelayProxyEnabled()) return attempt(propose, PROXY_TIMEOUT_MS);
  try {
    return await attempt(propose, DIRECT_TIMEOUT_MS);
  } catch (error) {
    // Only a timeout points at a blocked network; a rejection is something
    // else, and routing around it would hide it.
    if (!(error instanceof RelayTimeoutError)) throw error;
    enableRelayProxy();
    return attempt(propose, PROXY_TIMEOUT_MS);
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
        // Refreshed before every connect; see attempt().
        redirect: { native: "", universal: returnTarget() },
      },
    });
  }
  return clientPromise;
}
