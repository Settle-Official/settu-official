/**
 * Client-side status polling for one bridge (plan Task 20, spec §9): every
 * 5 s, only while the page is visible, until the bridge is final or 20 min
 * have passed. No streams: the server finishes the bridge either way, this
 * only keeps the screen current. Returns `stop`.
 */

import type { BridgeStatusView } from "./bridge-store";

export const POLL_INTERVAL_MS = 5_000;
export const POLL_MAX_MS = 20 * 60_000;

export interface PollDeps {
  now(): number;
  isVisible(): boolean;
  fetchStatus(id: string): Promise<BridgeStatusView | null>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibilityChange(fn: () => void): () => void;
}

export const isFinalStatus = (s: BridgeStatusView["status"]) => s === "completed" || s === "failed";

export function pollBridgeStatus(
  id: string,
  onUpdate: (view: BridgeStatusView) => void,
  deps: PollDeps = browserPollDeps(),
  onTimeout?: () => void,
): () => void {
  const started = deps.now();
  let stopped = false;
  let timer: unknown = null;
  let inFlight = false;

  const stop = () => {
    stopped = true;
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
    unsubscribe();
  };

  const schedule = () => {
    if (stopped) return;
    timer = deps.setTimeout(() => {
      timer = null;
      void tick();
    }, POLL_INTERVAL_MS);
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    if (deps.now() - started >= POLL_MAX_MS) {
      stop();
      onTimeout?.();
      return;
    }
    // Hidden: fetch nothing; the visibility listener resumes us.
    if (!deps.isVisible()) return;
    inFlight = true;
    try {
      const v = await deps.fetchStatus(id);
      if (stopped) return;
      if (v) {
        onUpdate(v);
        if (isFinalStatus(v.status)) {
          stop();
          return;
        }
      }
    } catch {
      // A failed poll is retried on the next tick.
    } finally {
      inFlight = false;
    }
    schedule();
  };

  const unsubscribe = deps.onVisibilityChange(() => {
    if (stopped || !deps.isVisible() || timer !== null) return;
    void tick();
  });

  void tick();
  return stop;
}

export function browserPollDeps(): PollDeps {
  return {
    now: () => Date.now(),
    isVisible: () => document.visibilityState === "visible",
    fetchStatus: async (id) => {
      const res = await fetch(`/api/bridge/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()) as BridgeStatusView;
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    onVisibilityChange: (fn) => {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
  };
}
