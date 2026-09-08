// Paycrest Payout Provider Implementation

import type { PayoutProviderAdapter } from "./payout-provider";
import type {
  PayoutOrderRequest,
  PayoutOrderResponse,
  PayoutStatus,
  CreateOnrampOrderParams,
  CreateOfframpOrderV2Params,
  MarketOffer,
  MarketSide,
  OnrampOrderResponse,
} from "../types";

const PAYCREST_API_BASE = "https://api.paycrest.io/v1";
// Onramp requires v2 (v1 is offramp-only). Kept separate so the working v1
// offramp path is untouched.
const PAYCREST_API_V2_BASE = "https://api.paycrest.io/v2";

// The markets endpoint is per-IP rate limited and cached ~10s upstream, while the
// quote route fires on a 500ms debounce. This collapses a typing burst into one
// call; it is per-instance on Vercel and is not meant to be a real cache.
const MARKET_BOOK_TTL_MS = 5_000;
const marketBookCache = new Map<string, { at: number; book: MarketOffer[] }>();

// The supported-currency list changes very rarely, so it is cached far longer
// than the book. Shared across adapter instances by design — it is account
// independent.
const CURRENCY_TTL_MS = 10 * 60_000;
let currencyCache: { at: number; codes: string[] } | null = null;

/**
 * Corridors Paycrest supported when this was written. Only used when the live
 * lookup fails — a Paycrest outage should degrade the currency check, not
 * block quoting entirely.
 */
export const FALLBACK_CURRENCIES = ["NGN", "KES", "UGX", "TZS"];

class PaycrestHttpError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "PaycrestHttpError";
    this.status = status;
    this.details = details;
  }
}

export class PaycrestAdapter implements PayoutProviderAdapter {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async fetch<T>(
    endpoint: string,
    options: RequestInit = {},
    baseUrl: string = PAYCREST_API_BASE,
  ): Promise<T> {
    const url = `${baseUrl}${endpoint}`;
    
    // Abort after 15 seconds to avoid hanging on network issues
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          "API-Key": this.apiKey,
          ...options.headers,
        },
      });
    } catch (fetchErr: any) {
      clearTimeout(timer);
      if (fetchErr?.name === "AbortError") {
        throw new PaycrestHttpError(
          `Paycrest API request timed out (15s): ${endpoint}`,
          504,
        );
      }
      throw new PaycrestHttpError(
        `Paycrest API network error: ${fetchErr.message}`,
        502,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
            const message =
        error?.message ||
        error?.error ||
        `Paycrest API error: ${response.status} ${response.statusText}`;
      throw new PaycrestHttpError(message, response.status, error);
    }

    const data = await response.json();
        return data.data || data;
  }

  /**
   * Supported fiat codes, cached for CURRENCY_TTL_MS. Falls back to
   * FALLBACK_CURRENCIES if Paycrest is unreachable.
   */
  async getSupportedCurrencyCodes(): Promise<string[]> {
    if (currencyCache && Date.now() - currencyCache.at < CURRENCY_TTL_MS) {
      return currencyCache.codes;
    }
    try {
      const currencies = await this.getCurrencies();
      const codes = (Array.isArray(currencies) ? currencies : [])
        .map((c) => String(c?.code ?? "").toUpperCase())
        .filter(Boolean);
      if (codes.length === 0) return FALLBACK_CURRENCIES;
      currencyCache = { at: Date.now(), codes };
      return codes;
    } catch {
      return FALLBACK_CURRENCIES;
    }
  }

  /** Whether Paycrest currently routes this fiat corridor. */
  async isSupportedCurrency(currency: string): Promise<boolean> {
    const code = String(currency ?? "").toUpperCase();
    return (await this.getSupportedCurrencyCodes()).includes(code);
  }

  async getCurrencies(): Promise<
    Array<{
      code: string;
      name: string;
      symbol: string;
    }>
  > {
    return this.fetch("/currencies");
  }

  async getInstitutions(currency: string): Promise<
    Array<{
      code: string;
      name: string;
    }>
  > {
    return this.fetch(`/institutions/${currency}`);
  }

  async verifyAccount(
    institution: string,
    accountIdentifier: string,
  ): Promise<string> {
    const result = await this.fetch<{ accountName?: string; data?: string }>(
      "/verify-account",
      {
        method: "POST",
        body: JSON.stringify({
          institution,
          accountIdentifier,
        }),
      },
    );
    return result.accountName || result.data || "";
  }

  async getRate(
    token: string,
    amount: string,
    currency: string,
    options?: {
      network?: string;
      providerId?: string;
    },
  ): Promise<number> {
    const query = new URLSearchParams();
    if (options?.network) {
      query.set("network", options.network);
    }
    if (options?.providerId) {
      query.set("provider_id", options.providerId);
    }

    const endpoint = `/rates/${encodeURIComponent(token)}/${encodeURIComponent(
      amount,
    )}/${encodeURIComponent(currency)}${query.toString() ? `?${query.toString()}` : ""}`;

    // Paycrest returns "data" as a numeric string in many cases
    const result = await this.fetch<string | number>(endpoint);
    const parsedRate =
      typeof result === "number" ? result : Number.parseFloat(result);

    if (!Number.isFinite(parsedRate)) {
      throw new Error("Invalid rate response from Paycrest");
    }

    return parsedRate;
  }

  /**
   * Fetch the market book for one corridor (Paycrest v2, public endpoint).
   *
   * Returns the raw `book` rows — ranking lives in provider-routing.ts. An
   * unparseable payload yields an empty book rather than throwing, so callers
   * can fall back to /v1/rates.
   */
  async getMarketBook(params: {
    side: MarketSide;
    fiat: string;
    token: string;
    network: string;
  }): Promise<MarketOffer[]> {
    const side = params.side.toLowerCase();
    const fiat = params.fiat.toUpperCase();
    const token = params.token.toUpperCase();
    const network = params.network.toLowerCase();

    const cacheKey = `${side}|${fiat}|${token}|${network}`;
    const cached = marketBookCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MARKET_BOOK_TTL_MS) {
      return cached.book;
    }

    const query = new URLSearchParams({ side, fiat, token, network });

    // The shared fetch() already unwrapped the envelope, so this is `data`.
    const result = await this.fetch<{ book?: MarketOffer[] }>(
      `/markets?${query.toString()}`,
      {},
      PAYCREST_API_V2_BASE,
    );
    const book = Array.isArray(result?.book) ? result.book : [];

    marketBookCache.set(cacheKey, { at: Date.now(), book });
    return book;
  }

  /**
   * Create an offramp order on v2, optionally pinned to an ordered queue of
   * providers. v1 has no `providerIds`, which is the reason this exists.
   *
   * Note the response is normalized back to the flat v1 shape: v2 nests the
   * settlement address under `providerAccount`, and callers use it as the CCTP
   * mint recipient.
   */
  async createOfframpOrderV2(
    params: CreateOfframpOrderV2Params,
  ): Promise<PayoutOrderResponse> {
    const providerIds = params.providerIds?.filter(Boolean) ?? [];

    const body = {
      amount: String(params.amount),
      rate: String(params.rate),
      ...(params.reference ? { reference: params.reference } : {}),
      source: {
        type: "crypto" as const,
        currency: params.token.toUpperCase(),
        network: params.network.toLowerCase(),
        refundAddress: params.refundAddress,
      },
      destination: {
        type: "fiat" as const,
        currency: params.currency.toUpperCase(),
        ...(providerIds.length ? { providerIds } : {}),
        recipient: {
          institution: params.recipient.institution,
          accountIdentifier: params.recipient.accountIdentifier,
          accountName: params.recipient.accountName,
          memo: params.recipient.memo || "Settu offramp",
          ...(params.recipient.metadata &&
          Object.keys(params.recipient.metadata).length
            ? { metadata: params.recipient.metadata }
            : {}),
        },
      },
    };

    const raw = await this.fetch<
      PayoutOrderResponse & {
        providerAccount?: { receiveAddress?: string };
      }
    >("/sender/orders", { method: "POST", body: JSON.stringify(body) }, PAYCREST_API_V2_BASE);

    return {
      ...raw,
      receiveAddress: raw?.providerAccount?.receiveAddress ?? raw?.receiveAddress,
    } as PayoutOrderResponse;
  }

  async createOrder(request: PayoutOrderRequest): Promise<PayoutOrderResponse> {
    return this.fetch("/sender/orders", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async getOrderStatus(orderId: string): Promise<{
    status: PayoutStatus;
    id: string;
  }> {
    return this.fetch(`/sender/orders/${orderId}`);
  }

  // --- Onramp (fiat → crypto), Paycrest v2 ---------------------------------

  /**
   * Create an onramp order. Returns the order id plus the virtual bank account
   * (providerAccount) the user must deposit fiat into. The crypto is delivered
   * to `recipientAddress` on `network` — for our custodial flow that's the
   * platform Base hot wallet, which then bridges to the user's Stellar wallet.
   */
  async createOnrampOrder(
    params: CreateOnrampOrderParams,
  ): Promise<OnrampOrderResponse> {
    const body = {
      amount: params.fiatAmount,
      amountIn: "fiat" as const,
      ...(params.rate ? { rate: params.rate } : {}),
      ...(params.reference ? { reference: params.reference } : {}),
      source: {
        type: "fiat" as const,
        currency: params.currency.toUpperCase(),
        ...(params.country ? { country: params.country } : {}),
        refundAccount: {
          institution: params.refundAccount.institution,
          accountIdentifier: params.refundAccount.accountIdentifier,
          accountName: params.refundAccount.accountName,
        },
      },
      destination: {
        type: "crypto" as const,
        currency: (params.cryptoCurrency ?? "USDC").toUpperCase(),
        recipient: {
          address: params.recipientAddress,
          network: (params.network ?? "base").toLowerCase(),
        },
      },
    };

    return this.fetch<OnrampOrderResponse>(
      "/sender/orders",
      { method: "POST", body: JSON.stringify(body) },
      PAYCREST_API_V2_BASE,
    );
  }

  /** Fetch a v2 order's current status (onramp or offramp). */
  async getOrderStatusV2(orderId: string): Promise<{
    id: string;
    status: string;
    direction?: string;
  }> {
    return this.fetch(
      `/sender/orders/${orderId}`,
      {},
      PAYCREST_API_V2_BASE,
    );
  }
}

// Helper function to map Paycrest webhook event names to our PayoutStatus.
// Prefer the bare `data.status` from the v2 payload; use this only as a
// fallback when a status field is absent.
export function mapPaycrestStatus(webhookStatus: string): PayoutStatus {
  switch (webhookStatus) {
    case "payment_order.pending":
      return "pending";
    case "payment_order.deposited":
      return "deposited";
    case "payment_order.validated":
      return "validated";
    case "payment_order.settling":
      return "settling";
    case "payment_order.settled":
      return "settled";
    case "payment_order.refunding":
      return "refunding";
    case "payment_order.refunded":
      return "refunded";
    case "payment_order.expired":
      return "expired";
    default:
      return "unknown";
  }
}
