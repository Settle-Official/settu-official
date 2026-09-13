// Stellar over WalletConnect, paired directly rather than through
// stellar-wallets-kit.
//
// The kit publishes its pairing URI to an AppKit instance of its own, and
// AppKit only mounts a modal for whichever instance is created first. With a
// shared instance owning that element the kit's sheet never appears, so on
// mobile its connect promise waits on an approval nobody can give. Rather than
// keep working around that, this pairs Stellar the same way EVM does — our
// SignClient, our sheet — which is the path that demonstrably works.
//
// The kit still handles desktop, where browser extensions make it the better
// route and no WalletConnect sheet is involved.

import { getSignClient } from "@/lib/wallet/sign-client";
import { openSheet, closeSheet } from "@/lib/wallet/appkit";

const CHAIN = "stellar:pubnet";
const SIGN_METHOD = "stellar_signXDR";

// Long enough to switch apps, approve and come back; short enough that a
// dismissed sheet doesn't strand the caller on "connecting". WalletConnect
// never times this out itself — `approval()` settles only on approval,
// rejection or proposal expiry (~5 min), and a dismissed sheet is none of
// those — so this clock is the only thing that frees the caller.
const APPROVAL_TIMEOUT_MS = 90_000;

// Carrier/cellular blocking of the relay is the confirmed cause of a connect
// that opens the sheet and then never settles, so lead with it.
const TIMEOUT_MESSAGE =
  "Couldn't complete the connection in time. Some mobile carriers block the " +
  "connection over cellular data — try switching to Wi-Fi.";

export interface StellarWcSession {
  address: string;
  topic: string;
}

/**
 * Opens the wallet sheet and pairs a Stellar account.
 *
 * Only `stellar_signXDR` is required. Requiring more — or requiring events —
 * makes wallets that support fewer reject the whole proposal, which looks to a
 * user like the wallet simply not working.
 */
export async function connectStellarViaWalletConnect(): Promise<StellarWcSession> {
  const client = await getSignClient();

  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      stellar: { methods: [SIGN_METHOD], chains: [CHAIN], events: [] },
    },
  });

  if (uri) await openSheet(uri);

  const timeout = new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), APPROVAL_TIMEOUT_MS),
  );

  try {
    const session = await Promise.race([approval(), timeout]);
    const account = session.namespaces.stellar?.accounts?.[0];
    if (!account) throw new Error("Wallet did not return a Stellar account");
    // CAIP-10: "stellar:pubnet:G..."
    return { address: account.split(":")[2], topic: session.topic };
  } finally {
    // Closes on approval, rejection and timeout alike, so the sheet never
    // outlives the attempt that opened it.
    await closeSheet();
  }
}

export async function signXdrViaWalletConnect(
  topic: string,
  xdr: string,
): Promise<string> {
  const client = await getSignClient();

  // A topic outlives the session it names, and using a dead one throws
  // WalletConnect's opaque "No matching key".
  if (!client.session.keys.includes(topic)) {
    throw new Error("Your wallet session has expired. Reconnect and try again.");
  }

  const result = await client.request<{ signedXDR: string }>({
    topic,
    chainId: CHAIN,
    request: { method: SIGN_METHOD, params: { xdr } },
  });
  return result.signedXDR;
}

export async function disconnectStellarWalletConnect(topic: string): Promise<void> {
  const client = await getSignClient();
  if (!client.session.keys.includes(topic)) return;
  await client.disconnect({
    topic,
    reason: { code: 6000, message: "User disconnected" },
  });
}
