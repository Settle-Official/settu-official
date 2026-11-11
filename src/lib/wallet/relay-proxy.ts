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

import { WC_DEBUG_KEY, WC_LOG_EVENT } from "./wc-debug";

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
//
// With ?wcdebug=1 (see wc-debug.ts) it also logs each relay socket's life and
// the page going to the background and back.
export const RELAY_SOCKET_SHIM = `(function(){try{
var N=window.WebSocket;if(!N||N.__settu)return;
var H=${JSON.stringify(RELAY_HOST_URL)},P=${JSON.stringify(RELAY_PROXY_PATH)},K=${JSON.stringify(STORAGE_KEY)},DK=${JSON.stringify(WC_DEBUG_KEY)};
var dbg=false;try{var q=new URLSearchParams(location.search).get("wcdebug");if(q==="1")localStorage.setItem(DK,"1");if(q==="0")localStorage.removeItem(DK);dbg=localStorage.getItem(DK)==="1"}catch(e){}
function L(m){if(!dbg)return;(window.__settuWcLog=window.__settuWcLog||[]).push(new Date().toISOString().slice(11,19)+" "+m);try{window.dispatchEvent(new Event(${JSON.stringify(WC_LOG_EVENT)}))}catch(e){}}
if(dbg){L("page load "+location.pathname);document.addEventListener("visibilitychange",function(){L("page "+document.visibilityState)})}
function on(){if(window.__settuRelayProxy)return true;try{return Number(localStorage.getItem(K))>Date.now()}catch(e){return false}}
var n=0;
function W(u,p){var s=String(u),relay=s.indexOf(H)===0,via="direct";
if(relay&&on()){var rest=s.slice(H.length).replace(/^\\//,"");s=location.origin.replace(/^http/,"ws")+P+rest;via="proxy"}
var w=arguments.length>1?new N(s,p):new N(s);
if(dbg&&(relay||s.indexOf("walletconnect")>-1)){var id=++n,host=s.split("?")[0];L("socket#"+id+" "+via+" "+host);
w.addEventListener("open",function(){L("socket#"+id+" open")});
w.addEventListener("close",function(e){L("socket#"+id+" close "+e.code+" "+(e.reason||""))});
w.addEventListener("error",function(){L("socket#"+id+" error")})}
return w}
W.prototype=N.prototype;W.CONNECTING=0;W.OPEN=1;W.CLOSING=2;W.CLOSED=3;W.__settu=true;
window.WebSocket=W}catch(e){}})();`;
