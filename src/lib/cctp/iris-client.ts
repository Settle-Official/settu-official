import { CCTP_CONFIG } from "./constants";

export interface AttestationMessage {
  message: string;
  attestation: string;
  status: string;
  eventNonce?: string;
}

interface AttestationResponse {
  messages: AttestationMessage[];
}

export interface BurnFeeQuote {
  /**
   * Minimum Fast Transfer fee, in basis points (bps, 1/100 of a percent) of
   * the burn amount — NOT an atomic token amount. Confirmed directly against
   * the live API (`GET /v2/burn/USDC/fees/{src}/{dst}` returns e.g.
   * `{"finalityThreshold":1000,"minimumFee":1.3}`), which can be a fractional
   * number. Convert to an atomic maxFee for a given burn with
   * `computeAtomicFee` below — never `BigInt()` this directly.
   */
  minimumFeeBps: number;
}

export function buildMessagesUrl(
  baseUrl: string,
  sourceDomain: number,
  transactionHash: string,
): string {
  return `${baseUrl}/v2/messages/${sourceDomain}?transactionHash=${transactionHash}`;
}

export function buildFeeQuoteUrl(
  baseUrl: string,
  sourceDomain: number,
  destDomain: number,
): string {
  return `${baseUrl}/v2/burn/USDC/fees/${sourceDomain}/${destDomain}`;
}

/**
 * Single-shot attestation fetch (no internal polling loop — the caller
 * decides cadence, since offramp/onramp drive this from different places:
 * SSE tick vs daily cron sweep). Returns null while still pending; throws on
 * a real HTTP error other than 404 (not-found-yet is expected while pending).
 */
export async function fetchAttestation(params: {
  sourceDomain: number;
  transactionHash: string;
}): Promise<AttestationMessage | null> {
  const url = buildMessagesUrl(
    CCTP_CONFIG.irisApiUrl,
    params.sourceDomain,
    params.transactionHash,
  );
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Iris /v2/messages failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as AttestationResponse;
  const first = data.messages?.[0];
  if (!first || first.status !== "complete") return null;
  return first;
}

export interface DecodedBurnMessage {
  status: string;
  /** 0x-prefixed bytes32; the low 20 bytes are the EVM mint recipient. */
  mintRecipient?: string;
  /** Atomic USDC (6 dp) as a decimal string. */
  amount?: string;
  destinationDomain?: string;
}

/**
 * Fetch the first CCTP message for a burn tx and expose its decoded fields —
 * used by the burn-backstop sweep to confirm an on-chain `deposit_for_burn`
 * really targets a given Paycrest receive address before registering it.
 * Returns null if Iris has no message for the hash yet (404).
 */
export async function fetchBurnMessage(params: {
  sourceDomain: number;
  transactionHash: string;
}): Promise<DecodedBurnMessage | null> {
  const url = buildMessagesUrl(
    CCTP_CONFIG.irisApiUrl,
    params.sourceDomain,
    params.transactionHash,
  );
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Iris /v2/messages failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    messages?: Array<{
      status?: string;
      decodedMessage?: {
        mintRecipient?: string;
        amount?: string;
        destinationDomain?: string;
      };
    }>;
  };
  const first = data.messages?.[0];
  if (!first) return null;
  return {
    status: first.status ?? "unknown",
    mintRecipient: first.decodedMessage?.mintRecipient,
    amount: first.decodedMessage?.amount,
    destinationDomain: first.decodedMessage?.destinationDomain,
  };
}

/** Real, live fee quote — replaces the old flat/guessed Allbridge relayer fee. */
export async function getBurnFeeQuote(params: {
  sourceDomain: number;
  destDomain: number;
}): Promise<BurnFeeQuote> {
  const url = buildFeeQuoteUrl(
    CCTP_CONFIG.irisApiUrl,
    params.sourceDomain,
    params.destDomain,
  );
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Iris fee quote failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  // Response is an array of finality-threshold-keyed fee entries; take the
  // Fast Transfer (finalityThreshold: 1000) entry's minimumFee.
  const fast = Array.isArray(data)
    ? data.find((e: any) => e.finalityThreshold === 1000)
    : undefined;
  const bps = Number(fast?.minimumFee ?? 0);
  return { minimumFeeBps: Number.isFinite(bps) ? bps : 0 };
}

/**
 * Converts a Fast Transfer fee quote (bps) into an atomic maxFee for a given
 * burn amount, rounding up so we never submit below Circle's minimum (a
 * too-low maxFee leaves the burn stuck unattested). `minimumFeeBps` can carry
 * fractional precision (e.g. 1.3), so scale before dividing rather than doing
 * float math against a bigint amount.
 */
export function computeAtomicFee(
  minimumFeeBps: number,
  amountAtomic: bigint,
): bigint {
  if (!Number.isFinite(minimumFeeBps) || minimumFeeBps <= 0) return BigInt(0);
  const PRECISION = BigInt(1_000_000); // keep 6 fractional digits of the bps rate
  const bpsScaled = BigInt(Math.round(minimumFeeBps * 1_000_000));
  const denominator = BigInt(10_000) * PRECISION;
  const numerator = amountAtomic * bpsScaled;
  return (numerator + denominator - BigInt(1)) / denominator; // ceiling division
}

/** Recover an expired/stuck Fast Transfer attestation. */
export async function reattest(nonce: string): Promise<void> {
  const res = await fetch(`${CCTP_CONFIG.irisApiUrl}/v2/reattest/${nonce}`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Iris reattest failed: ${res.status} ${await res.text()}`);
  }
}
