// One WalletConnect SignClient for every chain that pairs directly.
//
// Two clients would mean two copies of the same storage namespace
// ("wc@2:core") with independent in-memory state, which is how pairing data got
// corrupted before. One client can hold sessions for several namespaces at
// once, so Stellar and EVM share it.

import { SignClient } from "@walletconnect/sign-client";

let clientPromise: ReturnType<typeof SignClient.init> | null = null;

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
      metadata: {
        name: "Settu",
        description: "Convert USDC to your bank account in minutes.",
        url: origin,
        icons: [`${origin}/icons/icon-192.png`],
      },
    });
  }
  return clientPromise;
}
