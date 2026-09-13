import { SignClient } from "@walletconnect/sign-client";
import { EVM_SOURCE_CHAINS } from "@/lib/cctp/evm-chains";
import { openSheet, closeSheet, watchSheetDismissal } from "@/lib/wallet/appkit";
import { isMobileBrowser } from "@/lib/platform";

let clientPromise: ReturnType<typeof SignClient.init> | null = null;

function getClient() {
  if (!clientPromise) {
    const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    if (!projectId) throw new Error("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is missing");
    const origin =
      typeof window !== "undefined" ? window.location.origin : "https://settu.xyz";
    clientPromise = SignClient.init({
      projectId,
      metadata: {
        name: "Settu",
        description: "Stellar USDC <-> fiat, multi-chain",
        url: origin,
        icons: [`${origin}/icons/icon-192.png`],
        // Tells the wallet app how to bounce the user back here after they
        // approve. Without it, a mobile wallet can leave the user sitting in
        // the wallet app after signing, and the backgrounded browser tab
        // stays that way long enough that the relay drops the undelivered
        // response — the same "stuck on confirm transaction" failure
        // confirmed on the Stellar side (see wallet-adapter.ts) and fixed
        // there with this same field.
        redirect: { native: "", universal: origin },
      },
    });
  }
  return clientPromise;
}

const ALL_CHAIN_IDS = Object.values(EVM_SOURCE_CHAINS).map((c) => `eip155:${c.chainId}`);

export interface EvmSession {
  topic: string;
  address: `0x${string}`;
}

/**
 * Proposes one WalletConnect session covering every EVM chain this app
 * supports at once (WalletConnect's eip155 namespace allows proposing
 * multiple chain IDs in a single pairing) -- so switching between two
 * already-paired chains later is just a wallet_switchEthereumChain
 * request, not a full reconnect. Times out after 60s with a clear error
 * rather than hanging silently, given the unresolved relay issue seen
 * earlier on the Stellar side of this app.
 */
export async function proposeEvmSession(
  onUri: (uri: string) => void,
): Promise<EvmSession> {
  const client = await getClient();

  // Only Ethereum is required; the rest are optional. Listing all six as
  // required means a wallet that lacks any one of them rejects the whole
  // proposal, which silently excludes wallets that would otherwise work.
  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      eip155: {
        methods: ["eth_sendTransaction", "personal_sign"],
        chains: ["eip155:1"],
        events: ["chainChanged", "accountsChanged"],
      },
    },
    optionalNamespaces: {
      eip155: {
        methods: ["eth_sendTransaction", "personal_sign", "wallet_switchEthereumChain"],
        chains: ALL_CHAIN_IDS,
        events: ["chainChanged", "accountsChanged"],
      },
    },
  });

  // Watch before opening so the close-after-open transition can't be missed.
  const watcher = watchSheetDismissal();
  if (uri) {
    onUri(uri);
    // The one AppKit instance on the page — see src/lib/wallet/appkit.ts.
    await openSheet(uri);
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            "Wallet connection timed out — the pairing wasn't approved in time. Please try again.",
          ),
        ),
      180_000,
    ),
  );
  // approval() still settles later on proposal expiry; sink it so losing the
  // race doesn't surface as an unhandled rejection.
  const pending = approval();
  pending.catch(() => {});

  let session;
  try {
    session = await Promise.race([pending, watcher.dismissed, timeout]);
  } finally {
    // Close whether approved, rejected, dismissed or timed out, so the sheet
    // never outlives the attempt it belongs to.
    watcher.dispose();
    await closeSheet();
  }

  const account = session.namespaces.eip155?.accounts?.[0];
  if (!account) throw new Error("Wallet did not return an EVM account");
  const address = account.split(":")[2] as `0x${string}`;

  return { topic: session.topic, address };
}

/**
 * A session topic outlives the session it names: the wallet can disconnect, the
 * session can expire, or storage can be cleared while the app still holds the
 * string. Using it then throws WalletConnect's "No matching key. session topic
 * doesn't exist", which tells a user nothing they can act on.
 */
async function assertSession(topic: string): Promise<void> {
  const client = await getClient();
  if (!client.session.keys.includes(topic)) {
    throw new Error(
      "Your wallet session has expired. Reconnect your wallet and try again.",
    );
  }
}

// A request over an existing session carries no pairing URI, so nothing brings
// the wallet forward — on mobile it arrives backgrounded and the user sees no
// prompt at all. Deep-link into the wallet ourselves using its own redirect.
async function focusWallet(topic: string): Promise<void> {
  if (!isMobileBrowser() || typeof window === "undefined") return;
  try {
    const client = await getClient();
    const redirect = client.session.get(topic)?.peer?.metadata?.redirect;
    const target = redirect?.native || redirect?.universal;
    if (target) window.location.href = target;
  } catch {
    // Never let the focus attempt take down the request it belongs to.
  }
}

// Disconnecting an already-gone session is the outcome the caller wanted, so
// treat a missing topic as success rather than an error.
export async function disconnectEvmSession(topic: string): Promise<void> {
  const client = await getClient();
  if (!client.session.keys.includes(topic)) return;
  await client.disconnect({
    topic,
    reason: { code: 6000, message: "User disconnected" },
  });
}

export async function requestChainSwitch(topic: string, chainId: number): Promise<void> {
  await assertSession(topic);
  const client = await getClient();
  const pending = client.request({
    topic,
    chainId: `eip155:${chainId}`,
    request: {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    },
  });
  await focusWallet(topic);
  await pending;
}

export async function sendTransaction(
  topic: string,
  chainId: number,
  from: `0x${string}`,
  call: { to: `0x${string}`; data: `0x${string}` },
): Promise<string> {
  await assertSession(topic);
  const client = await getClient();
  const pending = client.request({
    topic,
    chainId: `eip155:${chainId}`,
    request: {
      method: "eth_sendTransaction",
      params: [{ from, to: call.to, data: call.data }],
    },
  }) as Promise<string>;
  await focusWallet(topic);
  return pending;
}

// personal_sign over the relay. The message is hex-encoded because the RPC
// takes bytes, not text; wallets decode it back to readable text for the user.
export async function signPersonalMessage(
  topic: string,
  chainId: number,
  from: `0x${string}`,
  message: string,
): Promise<string> {
  await assertSession(topic);
  const client = await getClient();
  const hex = `0x${Buffer.from(message, "utf8").toString("hex")}`;
  const pending = client.request({
    topic,
    chainId: `eip155:${chainId}`,
    request: { method: "personal_sign", params: [hex, from] },
  }) as Promise<string>;
  await focusWallet(topic);
  return pending;
}
