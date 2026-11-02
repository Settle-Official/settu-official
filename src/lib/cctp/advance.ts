import {
  getCctpTransfer,
  updateCctpTransfer,
  acquireAdvanceLock,
  releaseAdvanceLock,
  type CctpStatus,
} from "./cctp-store";
import { fetchAttestation, reattest } from "./iris-client";
import { submitBaseMint } from "./base-cctp";
import { submitMintAndForward } from "./stellar-cctp";

const MAX_ATTEMPTS = 20;

/**
 * Advances one CCTP transfer by whatever it's currently waiting on.
 *
 * Single-flight per transfer id: this is called from multiple independent
 * triggers (an SSE tick loop, the daily cron sweep, a manual status check),
 * and the SSE tick loop in particular can end up running more than one
 * instance concurrently — EventSource auto-reconnects on any drop, and each
 * reconnect spins up its own server-side stream with its own tick timer, all
 * polling the same transfer. Without a lock, two overlapping calls can both
 * read "attested" before either writes, both submit a mint, and the loser's
 * failure (a correctly-rejected duplicate — CCTP nonces are single-use) can
 * race the winner's success. A caller that doesn't get the lock just returns
 * the current persisted status and does no work; whichever call holds the
 * lock will finish and update the record, and the next tick picks it up.
 */
export async function advanceCctpTransfer(id: string): Promise<CctpStatus> {
  const record = await getCctpTransfer(id);
  if (!record) throw new Error(`No CCTP transfer record for id ${id}`);
  if (record.status === "completed" || record.status === "failed") {
    return record.status;
  }

  const gotLock = await acquireAdvanceLock(id);
  if (!gotLock) {
    return record.status;
  }

  try {
    return await advanceLocked(id, record);
  } finally {
    await releaseAdvanceLock(id);
  }
}

async function advanceLocked(
  id: string,
  record: NonNullable<Awaited<ReturnType<typeof getCctpTransfer>>>,
): Promise<CctpStatus> {
  try {
    if (record.status === "burned" || record.status === "attesting") {
      const attestation = await fetchAttestation({
        sourceDomain: record.sourceDomain,
        transactionHash: record.burnTxHash,
      });
      if (!attestation) {
        await updateCctpTransfer(id, {
          status: "attesting",
          attempts: record.attempts + 1,
        });
        return "attesting";
      }
      await updateCctpTransfer(id, {
        status: "attested",
        attestationMessage: attestation.message,
        attestationSignature: attestation.attestation,
      });
      return "attested";
    }

    if (record.status === "attested") {
      if (!record.attestationMessage || !record.attestationSignature) {
        throw new Error("attested status but attestation fields missing");
      }
      const mintTxHash =
        record.direction === "offramp"
          ? await submitBaseMint({
              messageHex: record.attestationMessage,
              attestationHex: record.attestationSignature,
            })
          : await submitMintAndForward({
              messageHex: record.attestationMessage,
              attestationHex: record.attestationSignature,
            });
      // Null: the message was already minted on-chain (see submitBaseMint),
      // so there's nothing left to send and nothing to wait for.
      if (mintTxHash === null) {
        await updateCctpTransfer(id, { status: "completed" });
        return "completed";
      }
      await updateCctpTransfer(id, { status: "minting", mintTxHash });
      return "minting";
    }

    if (record.status === "minting") {
      // Mint tx was submitted and awaited inside the submitter itself
      // (submitBaseMint/submitMintAndForward both wait for confirmation
      // before returning), so reaching this state on a later tick means the
      // previous tick's submission is done — mark complete.
      await updateCctpTransfer(id, { status: "completed" });
      return "completed";
    }

    return record.status;
  } catch (error: any) {
    const attempts = record.attempts + 1;
    const isExpiredAttestation =
      typeof error?.message === "string" && error.message.includes("expired");
    if (isExpiredAttestation && record.attestationMessage) {
      try {
        await reattest(record.attestationMessage);
        await updateCctpTransfer(id, {
          status: "attesting",
          attestationMessage: undefined,
          attestationSignature: undefined,
          attempts,
        });
        return "attesting";
      } catch {
        // fall through to generic failure handling below
      }
    }
    await updateCctpTransfer(id, {
      attempts,
      lastError: error?.message || String(error),
      status: attempts >= MAX_ATTEMPTS ? "failed" : record.status,
    });
    return attempts >= MAX_ATTEMPTS ? "failed" : record.status;
  }
}
