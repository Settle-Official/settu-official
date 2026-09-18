// Whether the browser is a phone or tablet.
//
// Used to decide wallet-connection strategy: browser extensions cannot exist on
// mobile, so any picker that leads with them is a dead end there. Tablets count
// as mobile for the same reason — they have wallet apps, not extensions — even
// when the landing page shows them the desktop layout.

export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(ua)) return true;

  // Two tablet cases hide behind desktop user agents: iPadOS 13+ reports
  // itself as a Macintosh, and Chrome on large Android tablets defaults to
  // "request desktop site". Multi-touch plus a coarse primary pointer means a
  // touch device either way; touch-screen laptops keep a fine (mouse/trackpad)
  // primary pointer, so they stay on the desktop path.
  const multiTouch = navigator.maxTouchPoints > 1;
  if (!multiTouch) return false;
  if (/Macintosh/.test(ua)) return true;
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}
