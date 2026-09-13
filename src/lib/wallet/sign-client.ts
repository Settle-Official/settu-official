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
      customStoragePrefix: STORAGE_PREFIX,
      metadata: {
        name: "Settu",
        description: "Convert USDC to your bank account in minutes.",
        url: origin,
        icons: [`${origin}/icons/icon-192.png`],
        // Without this the wallet has no way to hand its response back: the
        // user approves, the wallet reports success, and the signature is
        // dropped on the relay. Confirmed against Freighter on mobile.
        redirect: { native: "", universal: origin },
      },
    });
  }
  return clientPromise;
}
