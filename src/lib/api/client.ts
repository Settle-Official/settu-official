// Client for the Settu API (separate service, cross-origin).
//
// Auth travels two ways on purpose. The httpOnly session cookie is preferred —
// injected script cannot read it — but the API is on onrender.com while the app
// is on vercel.app, which makes it a third-party cookie. Safari blocks those
// outright, so a Bearer token is carried as a fallback.
//
// Once the API moves to api.<app-domain> the cookie becomes first-party and the
// token fallback can be deleted: drop rememberToken/clearToken and the
// Authorization header below.

const BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/$/, "");

// sessionStorage, not localStorage: the token dies with the tab and is not
// shared across them, so a stolen one has a much shorter useful life.
const TOKEN_KEY = "settu_token";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function rememberToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing can refuse storage; the cookie may still work.
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored means nothing to clear.
  }
}

function storedToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  if (!BASE_URL) {
    throw new ApiError(0, "not_configured", "NEXT_PUBLIC_API_BASE_URL is not set");
  }

  const token = storedToken();
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: options.method ?? "GET",
      // Sends the cookie where the browser allows it.
      credentials: "include",
      signal: options.signal,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "Couldn't reach Settu. Check your connection.");
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error ?? "unknown",
      payload?.message ?? "Something went wrong",
    );
  }
  return payload as T;
}
