// Opens the bridge stream that drives a CCTP offramp transfer from burn to
// mint (see /api/offramp/bridge/stream), and closes it once that's done.
//
// The stream used to be opened as a bare `new EventSource(...)` and never
// closed. When the server ends a finished stream, EventSource reconnects about
// every 3s, so every offramp left a loop running for as long as its tab stayed
// open. In November 2026 that was ~95% of all function invocations and most of
// the Redis reads.

const TERMINAL = new Set(["completed", "failed"]);

// Past this, the burn-sweep and cron finish the transfer server-side; keeping
// a phone tab polling is only cost.
const MAX_LIFETIME_MS = 15 * 60 * 1000;

export function driveBridgeTransfer(transferId: string): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    return () => {};
  }
  const source = new EventSource(
    `/api/offramp/bridge/stream/${encodeURIComponent(transferId)}`,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    source.close();
  };
  timer = setTimeout(stop, MAX_LIFETIME_MS);
  source.onmessage = (event) => {
    try {
      const { status } = JSON.parse(event.data) as { status?: string };
      if (status && TERMINAL.has(status)) stop();
    } catch {
      // Not a status frame; ignore it.
    }
  };
  return stop;
}
