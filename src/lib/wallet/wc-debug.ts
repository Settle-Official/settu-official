// On-screen WalletConnect trace, for diagnosing phone-only failures where
// there's no console to read. Off unless the page was opened with ?wcdebug=1
// (remembered on that device until ?wcdebug=0).
//
// Lines come from two places: RELAY_SOCKET_SHIM (socket open/close and the
// page going to the background and back, logged before any bundle loads)
// and wcLog() calls in the connect flow. Both write to window.__settuWcLog and
// fire "settu-wc-log", which WcDebugOverlay renders.

export const WC_DEBUG_KEY = "settu:wc-debug";
export const WC_LOG_EVENT = "settu-wc-log";

type LogWindow = Window & { __settuWcLog?: string[] };

export function isWcDebug(): boolean {
  try {
    return typeof window !== "undefined" && localStorage.getItem(WC_DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

export function wcLog(message: string): void {
  if (!isWcDebug()) return;
  const w = window as LogWindow;
  const time = new Date().toISOString().slice(11, 19);
  (w.__settuWcLog ??= []).push(`${time} ${message}`);
  window.dispatchEvent(new Event(WC_LOG_EVENT));
}

export function readWcLog(): string[] {
  return (typeof window !== "undefined" && (window as LogWindow).__settuWcLog) || [];
}

export function clearWcLog(): void {
  (window as LogWindow).__settuWcLog = [];
  window.dispatchEvent(new Event(WC_LOG_EVENT));
}
