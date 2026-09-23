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
//
// 5s was below Horizon's real latency: the public instance regularly answers
// in 5-18s under load, so this timed out, returned null, and — with no
// connectedAddress fallback being sent at the time — the permanent history
// record was silently never written. A settled transfer then showed nowhere
// in the user's History and produced no notification. Two attempts at 9s
// still bounds registration well under the caller's own budget.
const TIMEOUT_MS = 9000;
const ATTEMPTS = 2;

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

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const response = await fetch(
        `${HORIZON_URL}/transactions/${txHash.toLowerCase()}`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      // 404 means Horizon hasn't ingested the transaction yet, which a retry
      // can fix; other non-OK responses are worth one more try too.
      if (response.ok) {
        const tx = await response.json();

        // A failed transaction proves nothing about who controls the account.
        if (tx?.successful !== true) return null;

        const source = tx?.source_account;
        return typeof source === "string" && /^G[A-Z0-9]{55}$/.test(source)
          ? source
          : null;
      }
    } catch {
      // Timeout or network error — fall through and retry once.
    }
    if (attempt < ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Still unknown. The caller falls back to the client-supplied address,
  // which is unverified but far better than dropping the record entirely.
  console.warn(`[stellar-tx-source] could not attribute ${txHash}`);
  return null;
}
