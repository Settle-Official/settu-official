// A stray loop or a bored visitor shouldn't be able to run up LLM cost on
// this one route. In-memory is fine here: each serverless instance gets its
// own generous budget, and the failure mode of "resets on redeploy/cold
// start" is harmless for an abuse guard (unlike payout/ledger state, which
// uses Upstash Redis elsewhere in this codebase because it must survive
// exactly that).
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

let hits = new Map<string, number[]>();

export function checkAgentRateLimit(key: string): boolean {
  const now = Date.now();
  const timestamps = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (timestamps.length >= MAX_PER_WINDOW) {
    hits.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  hits.set(key, timestamps);
  return true;
}

export function _resetForTests(): void {
  hits = new Map();
}
