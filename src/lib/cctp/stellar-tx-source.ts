// Resolves who actually signed a Stellar burn, from the chain rather than the
// request body.
//
// `connectedAddress` arrives from the client and is unverified — anyone can
// POST any address and have it written into the permanent per-wallet history.
// That is harmless while the history is only used for display; it stops being
// harmless the moment cashback attaches to it, because writing into someone
// else's history becomes writing into someone else's earnings.
//
// A burn transaction is signed by its source account's key, so Horizon's
// `source_account` is cryptographic proof of control. It cannot be forged by a
// modified client, and it works retroactively on any hash.

const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org";

// The burn is already on-chain by the time this runs. Attribution is worth a
// short wait, never a stalled registration.
const TIMEOUT_MS = 5000;

/**
 * The source account of a successful Stellar transaction, or null.
 *
 * Null on anything uncertain — unknown hash, failed transaction, Horizon
 * unreachable. Attribution is best-effort by design: a wrong answer credits the
 * wrong wallet, so no answer is strictly better.
 */
export async function resolveStellarTxSource(
  txHash: string,
): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/i.test(txHash)) return null;

  try {
    const response = await fetch(
      `${HORIZON_URL}/transactions/${txHash.toLowerCase()}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!response.ok) return null;

    const tx = await response.json();

    // A failed transaction proves nothing about who controls the account.
    if (tx?.successful !== true) return null;

    const source = tx?.source_account;
    return typeof source === "string" && /^G[A-Z0-9]{55}$/.test(source)
      ? source
      : null;
  } catch {
    // Timeout, network error, or malformed response — all mean "unknown".
    return null;
  }
}
