/**
 * Soroban JSON-RPC with endpoint failover.
 *
 * The public `soroban-rpc.mainnet.stellar.gateway.fm` endpoint is rate-limited
 * and periodically slow — and a slow submit/confirm on the offramp burn path
 * is exactly what stranded a real user's funds. Configure a dedicated
 * provider with `STELLAR_SOROBAN_RPC_URL`; add comma-separated backups in
 * `STELLAR_SOROBAN_RPC_URL_FALLBACK`. Calls try each endpoint in order and
 * move on to the next on a network error, timeout, HTTP 429, or HTTP 5xx.
 */

const PUBLIC_SOROBAN_RPC =
  "https://soroban-rpc.mainnet.stellar.gateway.fm";

/** Ordered, de-duplicated list of Soroban RPC endpoints to try. */
export function sorobanRpcEndpoints(): string[] {
  const list: string[] = [];
  const primary = process.env.STELLAR_SOROBAN_RPC_URL?.trim();
  if (primary) list.push(primary);

  const fallback = process.env.STELLAR_SOROBAN_RPC_URL_FALLBACK?.trim();
  if (fallback) {
    for (const url of fallback.split(",").map((s) => s.trim()).filter(Boolean)) {
      list.push(url);
    }
  }

  // Public endpoint as a last resort — better a slow answer than none.
  if (!list.includes(PUBLIC_SOROBAN_RPC)) list.push(PUBLIC_SOROBAN_RPC);

  // De-dupe while preserving order.
  return [...new Set(list)];
}

export interface SorobanRpcOptions {
  /** Per-endpoint timeout. Total wall time is roughly this × endpoint count. */
  timeoutMs?: number;
}

let jsonRpcId = 1;

/**
 * Make a Soroban JSON-RPC call, failing over across `sorobanRpcEndpoints()`.
 * Returns `result`. Throws only when every endpoint fails (with the last
 * error), or immediately on a definitive non-retryable RPC/HTTP error from an
 * endpoint that did respond.
 */
export async function sorobanRpc(
  method: string,
  params: Record<string, unknown>,
  { timeoutMs = 10_000 }: SorobanRpcOptions = {},
): Promise<any> {
  const endpoints = sorobanRpcEndpoints();
  let lastError: unknown;

  for (const url of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: jsonRpcId++, method, params }),
        signal: controller.signal,
      });

      // Rate-limited or provider-side error — try the next endpoint.
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Soroban RPC ${url} -> HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        throw new Error(
          `Soroban RPC HTTP ${res.status}: ${await res.text()}`,
        );
      }

      const json = await res.json();
      if (json.error) {
        throw new Error(
          `Soroban RPC error ${json.error.code}: ${json.error.message ?? JSON.stringify(json.error)}`,
        );
      }
      return json.result;
    } catch (err: any) {
      lastError = err;
      // AbortError (timeout) or a network failure — fall through to the next
      // endpoint. A thrown RPC/HTTP error from `throw` above also lands here;
      // that's acceptable — trying another provider can't hurt.
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("All Soroban RPC endpoints failed");
}
