// Whether the browser is a phone or tablet.
//
// Used to decide wallet-connection strategy: browser extensions cannot exist on
// mobile, so any picker that leads with them is a dead end there.

/** iPadOS 13+ reports a Macintosh UA, so touch points are the tiebreaker. */
export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}
