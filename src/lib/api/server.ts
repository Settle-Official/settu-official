// Server-side twin of client.ts, for calls the web app's own server makes:
// route handlers, webhook handlers, cron. No user session applies to those, so
// they carry a shared service token instead.
//
// Config is read inside each call, never at module scope: these functions sit
// in modules that unit tests import, and a throw at import would break them.

// Its own error type rather than client.ts's: that module uses TypeScript
// parameter properties, which the test runner's type-stripping cannot parse,
// and the store modules importing this one are covered by tests.
export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
  }
}

const TOKEN_HEADER = "x-settu-service-token";
const DEFAULT_TIMEOUT_MS = 8_000;

interface ServiceOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  /** The caller's own session token, forwarded for endpoints that need a human. */
  credential?: string;
}

function config(): { baseUrl: string; token: string } {
  // SETTU_SERVICE_TOKEN is deliberately not NEXT_PUBLIC_*, so it is undefined
  // in a browser bundle. The window check turns that into a loud failure.
  if (typeof window !== "undefined") {
    throw new ServiceError(0, "server_only", "serviceFetch must not run in a browser");
  }

  const baseUrl = (
    process.env.SETTU_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    ""
  ).replace(/\/$/, "");
  const token = process.env.SETTU_SERVICE_TOKEN || "";

  if (!baseUrl || !token) {
    throw new ServiceError(
      0,
      "not_configured",
      "SETTU_API_BASE_URL and SETTU_SERVICE_TOKEN must both be set",
    );
  }
  return { baseUrl, token };
}

/** Throws on any failure. Use for reads and for writes a caller must react to. */
export async function serviceFetch<T>(
  path: string,
  options: ServiceOptions = {},
): Promise<T> {
  const { baseUrl, token } = config();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      // Bounded always: a sleeping backend must fail fast, never hang open.
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        [TOKEN_HEADER]: token,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.credential
          ? { Authorization: `Bearer ${options.credential}` }
          : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    const timedOut = (error as Error)?.name === "TimeoutError";
    throw new ServiceError(
      0,
      timedOut ? "timeout" : "network",
      timedOut
        ? `Settu API did not respond within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : "Couldn't reach the Settu API",
    );
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ServiceError(
      response.status,
      payload?.error ?? "unknown",
      payload?.message ?? "Something went wrong",
    );
  }
  return payload as T;
}

/**
 * Bounded and swallowed. A bookkeeping write must never fail the money movement
 * it describes, and the backfill repairs anything this drops.
 */
export async function serviceWrite(
  path: string,
  body: unknown,
  timeoutMs?: number,
  method: string = "POST",
): Promise<boolean> {
  try {
    await serviceFetch(path, { method, body, timeoutMs });
    return true;
  } catch (error) {
    // Logged, not thrown: this is the second leg of a dual write, and the
    // first one already succeeded.
    console.error(`[serviceWrite] ${path} failed:`, (error as Error)?.message);
    return false;
  }
}
