import { SignClient } from "@walletconnect/sign-client";
import { EVM_SOURCE_CHAINS } from "@/lib/cctp/evm-chains";

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
  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      eip155: {
        methods: ["eth_sendTransaction", "personal_sign", "wallet_switchEthereumChain"],
        chains: ALL_CHAIN_IDS,
        events: ["chainChanged", "accountsChanged"],
      },
    },
  });
  if (uri) onUri(uri);

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("Could not reach the WalletConnect relay. Please try again.")),
      60_000,
    ),
  );
  const session = await Promise.race([approval(), timeout]);

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
