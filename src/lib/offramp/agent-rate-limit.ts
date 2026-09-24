import { createRateLimit } from "../rate-limit";

// A stray loop or a bored visitor shouldn't be able to run up LLM cost on this
// one route. Resetting on cold start is harmless for an abuse guard.
const limiter = createRateLimit(10, 60_000);

export function checkAgentRateLimit(key: string): boolean {
  return limiter.check(key);
}

export function _resetForTests(): void {
  limiter.reset();
}
