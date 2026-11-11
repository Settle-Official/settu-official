// Routes WalletConnect's relay socket through settu.xyz when the phone can't
// reach the relay itself.
//
// Some Nigerian carriers block every WalletConnect relay host over mobile
// data (relay.walletconnect.org and all of its regional hosts), while
// settu.xyz still loads. Wi-Fi is unaffected. Through /api/wc-relay the phone
// only talks to us, and we talk to the relay.
//
// The client can't simply be configured with our URL as its relayUrl: it signs
// its relay JWT with relayUrl as the audience, and the relay rejects any other
// audience ("JWT validation error: Invalid audience"). So the client keeps the
// real relayUrl, and RELAY_SOCKET_SHIM (run in <head>, before any bundle
// captures window.WebSocket) rewrites only the socket's address.

export const RELAY_HOST_URL = "wss://relay.walletconnect.org";
export const RELAY_PROXY_PATH = "/api/wc-relay";

const STORAGE_KEY = "settu:wc-relay-proxy";
// Long enough to cover the rest of a session on a blocked network, short
// enough that a phone that only hit the block once goes back to direct.
const REMEMBER_MS = 3 * 24 * 60 * 60 * 1000;

/** True once this device has been switched to the proxy (and it hasn't lapsed). */
export function isRelayProxyEnabled(): boolean {
  try {
    const until = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

/** Sockets opened from now on go through the proxy. */
export function enableRelayProxy(): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Date.now() + REMEMBER_MS));
  } catch {
    // Storage blocked: the shim also reads the in-memory flag below.
  }
  (window as unknown as { __settuRelayProxy?: boolean }).__settuRelayProxy = true;
}

/**
 * Inline <head> script. It wraps window.WebSocket so that, while the proxy is
 * enabled, a socket for the relay host opens on our proxy with the same query
 * (auth, projectId, ua, ...). Anything else, and everything while the proxy is
 * off, goes to the native constructor untouched.
 *
 * It must run before WalletConnect loads: the library reads window.WebSocket
 * once, when its module first evaluates, and keeps that reference.
 */
export const RELAY_SOCKET_SHIM = `(function(){try{
var N=window.WebSocket;if(!N||N.__settu)return;
var H=${JSON.stringify(RELAY_HOST_URL)},P=${JSON.stringify(RELAY_PROXY_PATH)},K=${JSON.stringify(STORAGE_KEY)};
function on(){if(window.__settuRelayProxy)return true;try{return Number(localStorage.getItem(K))>Date.now()}catch(e){return false}}
function W(u,p){var s=String(u);
if(s.indexOf(H)===0&&on()){var rest=s.slice(H.length).replace(/^\\//,"");s=location.origin.replace(/^http/,"ws")+P+rest}
return arguments.length>1?new N(s,p):new N(s)}
W.prototype=N.prototype;W.CONNECTING=0;W.OPEN=1;W.CLOSING=2;W.CLOSED=3;W.__settu=true;
window.WebSocket=W}catch(e){}})();`;
