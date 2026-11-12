// What to tell someone whose connection can't reach WalletConnect.
//
// Confirmed 2026-11-12: on some Nigerian mobile networks the carrier's DNS
// fails to resolve WalletConnect's relay, for the wallet app as well as for
// us. Switching the phone to Cloudflare's resolver fixed it on mobile data
// (the 1.1.1.1 app in plain DNS mode was enough), and so does Wi-Fi.
export const BLOCKED_NETWORK_HELP =
  "Some mobile networks block wallet connections. Turn on the free " +
  "Cloudflare 1.1.1.1 app on iOS (on Android you can instead set Private DNS to " +
  "one.one.one.one), or switch to Wi-Fi, then try again.";
