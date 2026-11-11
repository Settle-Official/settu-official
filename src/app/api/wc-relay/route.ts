import { upgradeWebSocket } from "@vercel/functions";
import WebSocket from "ws";
import { RELAY_HOST_URL } from "@/lib/wallet/relay-proxy";

// WalletConnect relay proxy, for phones whose carrier blocks the relay (see
// src/lib/wallet/relay-proxy.ts). Pipes one browser socket to one relay socket,
// frame for frame. It reads nothing: relay payloads are end-to-end encrypted
// between the app and the wallet.
//
// A connection lasts at most maxDuration. That is fine: WalletConnect
// reconnects on its own, and the relay holds messages for a subscriber
// until it comes back.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Only these query parameters reach the relay; they're what the client puts in
// its relay URL.
const FORWARDED_PARAMS = [
  "auth",
  "projectId",
  "ua",
  "useOnCloseEvent",
  "origin",
  "bundleId",
  "packageName",
] as const;

const PRODUCTION_ORIGIN = "https://settu.xyz";

// Close codes a server may send. 1005/1006 are reserved for "no code" and
// "abnormal", and ws throws if asked to send them.
function sendableCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011;
}

export async function GET(request: Request) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const incoming = new URL(request.url);
  // Ours only: without this the route is an open relay proxy for any project.
  const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  if (!projectId || incoming.searchParams.get("projectId") !== projectId) {
    return new Response("Forbidden", { status: 403 });
  }

  const upstreamUrl = new URL(RELAY_HOST_URL);
  for (const name of FORWARDED_PARAMS) {
    const value = incoming.searchParams.get(name);
    if (value !== null) upstreamUrl.searchParams.set(name, value);
  }
  // The relay checks Origin against the project's allowed domains, so pass the
  // browser's through rather than presenting as a server. Preview deployments
  // live on *.vercel.app, which isn't on that list, so there we present the
  // production origin; without this, WalletConnect can't be tested on a preview.
  const origin =
    process.env.VERCEL_ENV === "preview"
      ? PRODUCTION_ORIGIN
      : request.headers.get("origin");

  return upgradeWebSocket(
    (client) =>
      new Promise<void>((resolve) => {
        const upstream = new WebSocket(upstreamUrl, {
          headers: origin ? { origin } : {},
        });
        // Frames the browser sends before the relay socket is open.
        const pending: { data: WebSocket.RawData; isBinary: boolean }[] = [];
        let finished = false;

        const finish = (code: number, reason: string) => {
          if (finished) return;
          finished = true;
          const c = sendableCode(code);
          for (const ws of [client, upstream]) {
            try {
              if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
              else if (ws.readyState === WebSocket.OPEN) ws.close(c, reason);
            } catch {
              ws.terminate();
            }
          }
          resolve();
        };

        client.on("message", (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
          else pending.push({ data, isBinary });
        });
        upstream.on("open", () => {
          for (const frame of pending.splice(0)) {
            upstream.send(frame.data, { binary: frame.isBinary });
          }
        });
        upstream.on("message", (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        });

        // The relay's close reason matters to the client (3000 is an auth
        // failure it reacts to), so pass it through.
        upstream.on("close", (code, reason) => finish(code, reason.toString()));
        client.on("close", (code, reason) => finish(code, reason.toString()));
        upstream.on("unexpected-response", (_req, res) =>
          finish(1011, `relay refused the connection (${res.statusCode})`),
        );
        upstream.on("error", () => finish(1011, "relay connection failed"));
        client.on("error", () => finish(1011, "client connection failed"));
      }),
  );
}
