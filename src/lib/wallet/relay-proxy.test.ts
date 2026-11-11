import test from "node:test";
import assert from "node:assert/strict";
import { RELAY_SOCKET_SHIM } from "./relay-proxy";

// Runs the inline <head> script against a fake page and returns the URL each
// `new WebSocket(...)` actually opened.
function loadShim(opts: { proxyUntil?: number; flag?: boolean }) {
  const opened: { url: string; protocols?: unknown }[] = [];
  class FakeSocket {
    constructor(url: string, protocols?: unknown) {
      opened.push({ url, protocols });
    }
  }
  const store = new Map<string, string>();
  if (opts.proxyUntil !== undefined) store.set("settu:wc-relay-proxy", String(opts.proxyUntil));
  const win: Record<string, unknown> = { WebSocket: FakeSocket };
  if (opts.flag) win.__settuRelayProxy = true;
  const location = { origin: "https://settu.xyz" };
  const localStorage = { getItem: (k: string) => store.get(k) ?? null };
  new Function("window", "location", "localStorage", RELAY_SOCKET_SHIM)(win, location, localStorage);
  const Ws = win.WebSocket as new (url: string, protocols?: unknown) => unknown;
  return { Ws, opened, FakeSocket, win };
}

const RELAY = "wss://relay.walletconnect.org/?auth=abc&projectId=p1&ua=x";

test("proxy off: relay sockets go to the relay untouched", () => {
  const { Ws, opened } = loadShim({});
  new Ws(RELAY, []);
  assert.equal(opened[0].url, RELAY);
});

test("proxy on (remembered): relay socket opens on our proxy with the same query", () => {
  const { Ws, opened } = loadShim({ proxyUntil: Date.now() + 60_000 });
  new Ws(RELAY, []);
  assert.equal(opened[0].url, "wss://settu.xyz/api/wc-relay?auth=abc&projectId=p1&ua=x");
  assert.deepEqual(opened[0].protocols, []);
});

test("proxy on (in-memory flag, storage blocked or empty)", () => {
  const { Ws, opened } = loadShim({ flag: true });
  new Ws("wss://relay.walletconnect.org?auth=abc");
  assert.equal(opened[0].url, "wss://settu.xyz/api/wc-relay?auth=abc");
});

test("a lapsed proxy choice goes back to direct", () => {
  const { Ws, opened } = loadShim({ proxyUntil: Date.now() - 1 });
  new Ws(RELAY);
  assert.equal(opened[0].url, RELAY);
});

test("other sockets are never rewritten, even with the proxy on", () => {
  const { Ws, opened } = loadShim({ flag: true });
  new Ws("wss://relay.walletconnect.com/?auth=abc");
  new Ws("wss://example.com/socket");
  assert.deepEqual(opened.map((o) => o.url), [
    "wss://relay.walletconnect.com/?auth=abc",
    "wss://example.com/socket",
  ]);
});

test("instanceof and readyState constants still work", () => {
  const { Ws, FakeSocket } = loadShim({});
  assert.ok(new Ws(RELAY) instanceof FakeSocket);
  assert.ok(new Ws(RELAY) instanceof (Ws as unknown as typeof FakeSocket));
  assert.equal((Ws as unknown as { OPEN: number }).OPEN, 1);
});

test("loading the script twice doesn't double-wrap", () => {
  const { win } = loadShim({});
  const once = win.WebSocket;
  new Function("window", "location", "localStorage", RELAY_SOCKET_SHIM)(win, { origin: "x" }, { getItem: () => null });
  assert.equal(win.WebSocket, once);
});
