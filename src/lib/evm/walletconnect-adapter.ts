import { SignClient } from "@walletconnect/sign-client";
import { EVM_SOURCE_CHAINS } from "@/lib/cctp/evm-chains";
import {
  openWalletConnectSheet,
  closeWalletConnectSheet,
} from "@/lib/stellar/wallet-adapter";

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

  if (uri) {
    onUri(uri);
    // Shares the one AppKit instance on the page — see openWalletConnectSheet.
    await openWalletConnectSheet(uri);
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
  let session;
  try {
    session = await Promise.race([approval(), timeout]);
  } finally {
    // Close whether approved, rejected or timed out, so the sheet never
    // outlives the attempt it belongs to.
    await closeWalletConnectSheet();
  }

  const account = session.namespaces.eip155?.accounts?.[0];
  if (!account) throw new Error("Wallet did not return an EVM account");
  const address = account.split(":")[2] as `0x${string}`;

  return { topic: session.topic, address };
}

export async function disconnectEvmSession(topic: string): Promise<void> {
  const client = await getClient();
  await client.disconnect({
    topic,
    reason: { code: 6000, message: "User disconnected" },
  });
}

export async function requestChainSwitch(topic: string, chainId: number): Promise<void> {
  const client = await getClient();
  await client.request({
    topic,
    chainId: `eip155:${chainId}`,
    request: {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    },
  });
}

export async function sendTransaction(
  topic: string,
  chainId: number,
  from: `0x${string}`,
  call: { to: `0x${string}`; data: `0x${string}` },
): Promise<string> {
  const client = await getClient();
  return client.request({
    topic,
    chainId: `eip155:${chainId}`,
    request: {
      method: "eth_sendTransaction",
      params: [{ from, to: call.to, data: call.data }],
    },
  }) as Promise<string>;
}

// personal_sign over the relay. The message is hex-encoded because the RPC
// takes bytes, not text; wallets decode it back to readable text for the user.
export async function signPersonalMessage(
  topic: string,
  chainId: number,
  from: `0x${string}`,
  message: string,
): Promise<string> {
  const client = await getClient();
  const hex = `0x${Buffer.from(message, "utf8").toString("hex")}`;
  return client.request({
    topic,
    chainId: `eip155:${chainId}`,
    request: { method: "personal_sign", params: [hex, from] },
  }) as Promise<string>;
}
