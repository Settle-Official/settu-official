// Stellar wallet adapter, backed by Stellar Wallets Kit.
//
// The kit owns wallet discovery, the picker modal, mobile deep-linking and
// session persistence. That combination is what makes mobile work: the
// previous hand-rolled WalletConnect layer guessed at a `freighterwallet://`
// deep link that Freighter has never published, so on a phone the pairing URI
// went nowhere and the approval promise hung forever. The kit instead resolves
// each wallet's deep link from the WalletConnect Explorer registry (via Reown
// AppKit), and falls back to a QR code on desktop.
//
// It also persists the session in localStorage, which fixes the other half of
// the mobile problem: session state used to live in a module-level variable,
// so iOS evicting the backgrounded tab while the user approved in their wallet
// dropped the connection on return.

import type { ModuleInterface } from "@creit.tech/stellar-wallets-kit";

export interface StellarWallet {
  /** Kit module id of the connected wallet, e.g. "freighter" or "wallet_connect". */
  type: string;
  publicKey: string;
  isConnected: boolean;
}

export const NETWORK_PASSPHRASE =
  "Public Global Stellar Network ; September 2015";

type Kit = typeof import("@creit.tech/stellar-wallets-kit").StellarWalletsKit;

let kitPromise: Promise<Kit> | null = null;

/**
 * The WalletConnect module also exposes the underlying Reown AppKit instance,
 * which we need in order to notice the user dismissing the wallet sheet.
 * Narrowed structurally rather than imported, so this stays a type-only
 * dependency on a shape the module already documents.
 */
interface WalletConnectModuleLike extends ModuleInterface {
  modal?: {
    subscribeState?: (
      callback: (state: { open: boolean }) => void,
    ) => () => void;
  };
}

/**
 * Handle on the WalletConnect module so we can wait for it to finish booting
 * before opening the picker. See waitForWalletConnectReady.
 */
let walletConnectModuleRef: WalletConnectModuleLike | null = null;

/**
 * Reject as soon as the wallet sheet is dismissed without a selection.
 *
 * Needed because the connect promise ultimately settles on WalletConnect's
 * `approval()`, which only resolves on approval, explicit rejection, or
 * proposal expiry — roughly five minutes. Closing the sheet is none of those,
 * so without this the caller waits on a promise that will not settle and the
 * button stays in its connecting state until a page reload.
 *
 * Only a close that follows an open counts: the sheet starts closed, so
 * reacting to the initial state would abort before it ever appeared.
 */
function watchForSheetDismissal(module: WalletConnectModuleLike): {
  dismissed: Promise<never>;
  dispose: () => void;
} {
  let dispose = () => {};
  const dismissed = new Promise<never>((_resolve, reject) => {
    const subscribe = module.modal?.subscribeState;
    if (!subscribe) return; // Never settles — the race then rests on fetchAddress alone.
    let sawOpen = false;
    const unsubscribe = subscribe.call(module.modal, (state) => {
      if (state.open) {
        sawOpen = true;
      } else if (sawOpen) {
        reject(new Error("Connection cancelled."));
      }
    });
    dispose = () => unsubscribe();
  });
  return { dismissed, dispose };
}

/**
 * Lazily import + initialize the kit, once per page load.
 *
 * The import is dynamic on purpose: the kit registers custom elements and
 * touches `window` at module scope, which would crash Next's server-side
 * prerender of any client component that imported it eagerly.
 */
async function getKit(): Promise<Kit> {
  if (!kitPromise) kitPromise = initKit();
  return kitPromise;
}

/**
 * iPadOS 13+ reports a Macintosh UA, so touch points are the tiebreaker.
 */
function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/**
 * `isAvailable()` only proves the SignClient object and modal instance exist
 * — not that the relay WebSocket underneath them is actually usable. A phone
 * on a network that can reach the relay's TLS handshake but not sustain a
 * publish (iCloud Private Relay, some carrier/firewall setups, a flaky relay
 * node) sails past `waitForWalletConnectReady` and then hangs on
 * `approval()`, which WalletConnect does not time out client-side. Race
 * against our own clock instead of trusting the SDK to ever settle.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Block until the WalletConnect module has finished booting, or give up.
 *
 * Why this is needed: WalletConnectModule's constructor assigns `modal`
 * synchronously but assigns `signClient` inside a fire-and-forget
 * `SignClient.init().then(...)`. Its `isAvailable()` is `!!signClient &&
 * !!modal` and returns immediately without awaiting that, so it reports false
 * for as long as the relay handshake is in flight.
 *
 * That matters because `authModal()` calls `refreshSupportedWallets()` exactly
 * once, as it opens, and never recomputes. Open the picker too early and
 * WalletConnect is rendered as an uninstalled wallet — tapping it just opens
 * walletconnect.com — and it stays that way for the life of the modal. The
 * window is wide enough to lose on a phone, where the relay connection is
 * slower than on desktop wifi.
 */
async function waitForWalletConnectReady(timeoutMs = 10_000): Promise<boolean> {
  if (!walletConnectModuleRef) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await walletConnectModuleRef.isAvailable()) return true;
    } catch {
      // Treat a throw as "not ready yet" and keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function initKit(): Promise<Kit> {
  const [{ StellarWalletsKit, Networks }, { defaultModules }, walletConnect] =
    await Promise.all([
      import("@creit.tech/stellar-wallets-kit"),
      import("@creit.tech/stellar-wallets-kit/modules/utils"),
      import("@creit.tech/stellar-wallets-kit/modules/wallet-connect"),
    ]);

  // defaultModules() deliberately omits WalletConnect because it needs a
  // projectId. It's also the only transport that reaches a mobile wallet app,
  // so it's the module that makes or breaks mobile.
  const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  // `redirect` tells the wallet app how to bounce the user back here after
  // they approve. Without it, Freighter iOS (and other WC wallets) leave the
  // user sitting in the wallet after signing, and the browser stays
  // backgrounded long enough that the relay can drop the undelivered
  // response — so `signTransaction` hangs forever on "Confirm transaction in
  // wallet". `universal` is the https origin; `native` is blank (no custom
  // scheme). The kit types `metadata` as Reown AppKit's shape, which omits
  // `redirect`, but it's passed straight through to SignClient.init where
  // @walletconnect/types *does* accept it — hence the cast.
  const wcMetadata = {
    name: "Settu",
    description: "Convert USDC to your bank account in minutes.",
    url: window.location.origin,
    icons: [`${window.location.origin}/icons/icon-192.png`],
    redirect: { native: "", universal: window.location.origin },
  } as ConstructorParameters<
    typeof walletConnect.WalletConnectModule
  >[0]["metadata"];
  const walletConnectModule = projectId
    ? new walletConnect.WalletConnectModule({
        projectId,
        metadata: wcMetadata,
        allowedChains: [walletConnect.WalletConnectTargetChain.PUBLIC],
      })
    : null;
  walletConnectModuleRef = walletConnectModule;

  // Every wallet in defaultModules() is extension-backed, and phones have no
  // extensions — so on mobile they all report unavailable and the kit lists
  // them anyway behind an "Install" badge, which reads as "you don't have
  // Freighter" to someone who has the Freighter *app*. Tapping one just opens
  // its download page. Registering only WalletConnect on mobile leaves exactly
  // the path that works.
  //
  // This is also right inside a wallet's in-app browser: Freighter's own
  // module returns unavailable when it detects its mobile build, because
  // WalletConnect is the intended transport there too.
  //
  // Note we can't express this with the kit's `authModal.hideUnsupportedWallets`
  // option — it's declared and settable in 2.6.0 but no component reads it.
  let modules: ModuleInterface[];
  if (walletConnectModule && isMobileBrowser()) {
    modules = [walletConnectModule];
  } else {
    modules = defaultModules();
    if (walletConnectModule) modules.push(walletConnectModule);
  }

  StellarWalletsKit.init({ modules, network: Networks.PUBLIC });
  return StellarWalletsKit;
}

function toWallet(kit: Kit, address: string | undefined): StellarWallet | null {
  if (!address) return null;
  let type = "unknown";
  try {
    type = kit.selectedModule?.productId ?? "unknown";
  } catch {
    // No module selected yet — the address alone is enough to be "connected".
  }
  return { type, publicKey: address, isConnected: true };
}

/**
 * Open the kit's wallet picker and connect whatever the user chooses.
 *
 * Replaces the old split between `connect()` on desktop and a bespoke
 * deep-link modal on mobile — the kit's modal handles both, including
 * detecting when the page is already running inside a wallet's in-app browser.
 */
export async function connectWallet(): Promise<StellarWallet> {
  // Fail loudly rather than opening a picker listing browser extensions that
  // cannot exist on a phone. That list is indistinguishable from "your wallet
  // isn't installed" — precisely the wrong thing to tell someone who has the
  // app — so an explicit config error is far more useful than a silent
  // fallback to a list that can't work.
  if (isMobileBrowser() && !process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID) {
    throw new Error(
      "Mobile wallets connect over WalletConnect, which isn't configured. " +
        "Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID (from " +
        "dashboard.walletconnect.com), then restart the dev server or redeploy.",
    );
  }

  const kit = await getKit();

  // Must happen before authModal(), which snapshots wallet availability as it
  // opens and never refreshes it. Mobile waits longer because WalletConnect is
  // the only module registered there and is worth waiting for; desktop has
  // extensions as an immediate fallback, so it shouldn't sit behind a slow
  // relay for long.
  const onMobile = isMobileBrowser();
  const walletConnectReady = await waitForWalletConnectReady(
    onMobile ? 10_000 : 3_000,
  );
  if (!walletConnectReady && onMobile) {
    // On mobile WalletConnect is the only registered module, so an unready one
    // means an empty or broken picker. Say what actually went wrong instead of
    // rendering a wallet the user can only "install".
    throw new Error(
      "Couldn't reach the WalletConnect relay. Check your connection and try again.",
    );
  }

  let address: string;
  try {
    if (onMobile && walletConnectModuleRef) {
      // Skip the kit's own picker on mobile: WalletConnect is the only module
      // registered there, so it would be a one-item list whose only purpose is
      // to open the sheet behind it. Selecting it directly takes the user
      // straight to the actual wallet list (Freighter, LOBSTR, ...) in one tap.
      //
      // setWallet + fetchAddress reproduce exactly what the picker's own
      // selection handler does — set selectedModuleId, call the module's
      // getAddress, store activeAddress — and both signals are persisted to
      // localStorage by the kit's effects, so session restore is unaffected.
      kit.setWallet(walletConnectModuleRef.productId);

      const watcher = watchForSheetDismissal(walletConnectModuleRef);
      const pending = kit.fetchAddress();
      // If dismissal wins the race, this one still rejects later (on proposal
      // expiry). Attach a sink now so that lands as a handled rejection.
      pending.catch(() => {});
      try {
        ({ address } = await withTimeout(
          Promise.race([pending, watcher.dismissed]),
          90_000,
          "Couldn't complete the connection in time. Check your network — " +
            "iCloud Private Relay or a VPN can block WalletConnect — and try again.",
        ));
      } finally {
        watcher.dispose();
      }
    } else {
      ({ address } = await kit.authModal());
    }
  } catch (error: any) {
    throw new Error(explainConnectError(error));
  }

  const wallet = toWallet(kit, address);
  if (!wallet) throw new Error("Wallet did not return an address");
  return wallet;
}

/**
 * Translate the relay's low-level close codes into something a human can act
 * on. Close code 3000 with "origin not allowed" in particular is pure
 * configuration: the Reown project restricts which origins may use its id, and
 * the current one isn't on the list. Raw, it reads like a network fault and
 * sends you looking in the wrong place entirely.
 */
function explainConnectError(error: any): string {
  const message: string =
    typeof error === "string" ? error : error?.message || String(error ?? "");

  // The relay accepted the WebSocket handshake but couldn't carry a message
  // over it — the SDK's own wording for "the socket looked open but isn't
  // usable". Seen on specific phones/networks (iCloud Private Relay, some
  // carrier or VPN setups) while other devices on the same account connect
  // fine, so it's a network condition on that device, not a broken session —
  // reconnecting Freighter or clearing the kit's storage won't help.
  if (/failed to publish/i.test(message)) {
    return (
      "Your connection to the WalletConnect network dropped mid-handshake. " +
      "This is usually iCloud Private Relay or a VPN interfering — try turning " +
      "Private Relay off (Settings → [your name] → iCloud → Private Relay) " +
      "or switching between Wi-Fi and cellular, then try again."
    );
  }

  if (/origin not allowed/i.test(message) || /\b3000\b/.test(message)) {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "this origin";
    return (
      `WalletConnect rejected this site's origin (${origin}). ` +
      `Add it to your project's allowed domains in the WalletConnect/Reown ` +
      `dashboard (dashboard.walletconnect.com), then reload. ` +
      `Tunnels like ngrok get a new hostname on every restart, so a temporary ` +
      `URL has to be re-added each time — or use a static domain.`
    );
  }

  if (/unauthorized|invalid.*project|project.*invalid/i.test(message)) {
    return `WalletConnect rejected the project id: ${message}`;
  }

  return message || "Failed to connect wallet";
}

/**
 * Cheap check for "has this browser ever connected a wallet here", used to
 * decide whether booting the kit on mount is worth it — it pulls in Reown
 * AppKit and every wallet module, which is a lot of JS to hand a visitor who
 * has never connected. First-timers load it on the Connect click instead.
 *
 * Matches on the kit's localStorage namespace rather than one specific key
 * (it writes activeAddress, selectedModuleId, usedWalletsIds and more), so a
 * key rename in a future kit version can't silently stop restoring sessions.
 */
export function hasStoredWalletSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      if (window.localStorage.key(i)?.startsWith("@StellarWalletsKit/")) {
        return true;
      }
    }
    return false;
  } catch {
    // localStorage blocked (Safari private mode) — nothing to restore.
    return false;
  }
}

/** Read a persisted session from kit state without prompting the wallet. */
export async function restoreWallet(): Promise<StellarWallet | null> {
  try {
    const kit = await getKit();
    const { address } = await kit.getAddress();

    // The kit seeds activeAddress and selectedModuleId from localStorage
    // independently, and resolves the module by matching that id against the
    // modules registered *now*. So a restored address can outlive its module —
    // if the id no longer matches anything registered, this getter throws and
    // signing would later fail with "Please set the wallet first".
    //
    // Reporting connected in that state is worse than reporting disconnected:
    // the user sees a wallet, and only finds out it can't sign at the moment
    // they try. Treat it as no session.
    void kit.selectedModule;

    return toWallet(kit, address);
  } catch {
    // Nothing stored, or the stored session can no longer sign.
    return null;
  }
}

/**
 * Follow kit state so an account switch inside the wallet, or a disconnect
 * from the kit's own profile modal, is reflected in the UI. Fires once on
 * subscribe with the current value.
 */
export async function onWalletStateChange(
  callback: (wallet: StellarWallet | null) => void,
): Promise<() => void> {
  const kit = await getKit();
  const { KitEventType } = await import("@creit.tech/stellar-wallets-kit");
  return kit.on(KitEventType.STATE_UPDATED, (event) => {
    callback(toWallet(kit, event.payload.address));
  });
}

export async function signTransaction(
  xdr: string,
  address?: string,
): Promise<string> {
  const kit = await getKit();
  const { signedTxXdr } = await kit.signTransaction(xdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address,
  });
  return signedTxXdr;
}

export async function disconnectWallet(): Promise<void> {
  const kit = await getKit();
  await kit.disconnect();
}
