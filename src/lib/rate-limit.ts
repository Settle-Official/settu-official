// In-memory sliding window, one budget per serverless instance. Right for an
// abuse guard; wrong for accounting state, which lives in Redis or Postgres.
export function createRateLimit(maxPerWindow: number, windowMs: number) {
  let hits = new Map<string, number[]>();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= maxPerWindow) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
    reset(): void {
      hits = new Map();
    },
  };
}

/** First forwarded hop, or one shared bucket when the header is absent. */
export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
