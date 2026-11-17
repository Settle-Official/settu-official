import { PublicKey } from "@solana/web3.js";
import {
  getCctpTransfer,
  updateCctpTransfer,
  acquireAdvanceLock,
  releaseAdvanceLock,
  type CctpStatus,
  type CctpTransferRecord,
} from "./cctp-store";
import { fetchAttestation, reattest } from "./iris-client";
import { CctpBaseGasError, submitBaseMint, submitEvmMint } from "./base-cctp";
import { submitMintAndForward } from "./stellar-cctp";
import { CctpGasError } from "./stellar-hot-wallet";
import { FINALITY_THRESHOLD } from "./constants";
import { parseCctpMessage } from "./message";
import type { EvmChainKey } from "./evm-chains";
import { bridgeChainByDomain, BRIDGE_CHAINS, type BridgeChainKey } from "../bridge/chains";
import { deriveUsdcAta } from "../bridge/address-live";
import { SolanaGasError, submitSolanaMint, type SolanaMintParams } from "../bridge/mint/solana";
import { MintTxFailedError, readReceivedAtomic } from "../bridge/received-amount";
import { notify } from "../notify/telegram";

const MAX_ATTEMPTS = 20;

type MintParams = { messageHex: string; attestationHex: string };

/** Everything advanceLocked touches outside itself, so tests never hit a network. */
export interface AdvanceDeps {
  update(
    id: string,
    patch: Partial<Omit<CctpTransferRecord, "id" | "createdAt">>,
  ): Promise<unknown>;
  fetchAttestation: typeof fetchAttestation;
  reattest: typeof reattest;
  /** Offramp: Base mint with the offramp hot wallet. */
  submitBaseMint(p: MintParams): Promise<string | null>;
  /** Onramp: Stellar Forwarder mint with the onramp hot wallet. */
  submitMintAndForward(p: MintParams): Promise<string | null>;
  /** Bridge, EVM destination, bridge relayer. */
  submitEvmMint(chain: EvmChainKey, p: MintParams): Promise<string | null>;
  /** Bridge, Stellar destination: Forwarder mint with the bridge relayer. */
  submitStellarBridgeMint(p: MintParams): Promise<string | null>;
  /** Bridge, Solana destination. */
  submitSolanaMint(p: SolanaMintParams): Promise<string | null>;
  readReceivedAtomic(
    dest: BridgeChainKey,
    mintTx: string,
    ctx: { mintRecipient: string },
  ): Promise<bigint>;
  notify(message: string, level?: "info" | "success" | "warning" | "critical"): Promise<unknown>;
  now(): number;
}

export const defaultAdvanceDeps: AdvanceDeps = {
  update: updateCctpTransfer,
  fetchAttestation,
  reattest,
  submitBaseMint: (p) => submitBaseMint(p),
  submitMintAndForward: (p) => submitMintAndForward(p),
  submitEvmMint: (chain, p) => submitEvmMint(chain, p, { signer: "bridge" }),
  submitStellarBridgeMint: (p) => submitMintAndForward(p, { signer: "bridge" }),
  submitSolanaMint: (p) => submitSolanaMint(p),
  readReceivedAtomic: (dest, tx, ctx) => readReceivedAtomic(dest, tx, ctx),
  notify,
  now: Date.now,
};

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

export async function advanceLocked(
  id: string,
  record: CctpTransferRecord,
  deps: AdvanceDeps = defaultAdvanceDeps,
): Promise<CctpStatus> {
  const bridge = record.direction === "bridge" ? record.bridge : undefined;
  if (record.direction === "bridge" && !bridge) {
    // A bridge record without its metadata can't be routed; never let it
    // fall into the offramp/onramp mint paths.
    return record.status;
  }
  try {
    if (record.status === "burned" || record.status === "attesting") {
      const attestation = await deps.fetchAttestation({
        sourceDomain: record.sourceDomain,
        transactionHash: record.burnTxHash,
      });
      if (!attestation) {
        await deps.update(id, {
          status: "attesting",
          attempts: record.attempts + 1,
        });
        return "attesting";
      }
      await deps.update(id, {
        status: "attested",
        attestationMessage: attestation.message,
        attestationSignature: attestation.attestation,
        ...(bridge
          ? {
              bridge: {
                ...bridge,
                attestedAt: deps.now(),
                ...(fellBackToStandard(bridge.speed, attestation.message)
                  ? { fellBackToStandard: true }
                  : {}),
              },
            }
          : {}),
      });
      return "attested";
    }

    if (record.status === "attested") {
      if (!record.attestationMessage || !record.attestationSignature) {
        throw new Error("attested status but attestation fields missing");
      }
      const params: MintParams = {
        messageHex: record.attestationMessage,
        attestationHex: record.attestationSignature,
      };
      const mintTxHash = bridge
        ? await submitBridgeMint(record, bridge, params, deps)
        : record.direction === "offramp"
          ? await deps.submitBaseMint(params)
          : await deps.submitMintAndForward(params);
      // Null: the message was already minted on-chain (see submitBaseMint),
      // so there's nothing left to send and nothing to wait for.
      if (mintTxHash === null) {
        await deps.update(id, { status: "completed" });
        return "completed";
      }
      await deps.update(id, { status: "minting", mintTxHash });
      return "minting";
    }

    if (record.status === "minting") {
      // Mint tx was submitted (and, for EVM/Solana, awaited) by the
      // submitter, so reaching this state on a later tick means the previous
      // tick's submission is done — mark complete. Bridges first read what
      // the user actually received from the destination tx.
      if (bridge && record.mintTxHash) {
        const received = await deps.readReceivedAtomic(
          bridgeDest(record).key,
          record.mintTxHash,
          { mintRecipient: record.mintRecipient },
        );
        await deps.update(id, {
          status: "completed",
          bridge: { ...bridge, receivedAtomic: received.toString() },
        });
        return "completed";
      }
      await deps.update(id, { status: "completed" });
      return "completed";
    }

    return record.status;
  } catch (error: any) {
    const message: string = error?.message || String(error);

    // Review focus 5: a relayer below its gas floor is waiting on a top-up,
    // not failing. Don't spend attempts (the floor check already alerted).
    if (bridge && isGasFloorError(error)) {
      await deps.update(id, { lastError: message });
      return record.status;
    }

    const attempts = record.attempts + 1;

    // The bridge's destination mint tx landed but failed on-chain: go back
    // and mint again (the already-minted check makes a retry safe).
    if (bridge && record.status === "minting" && error instanceof MintTxFailedError) {
      const status = attempts >= MAX_ATTEMPTS ? "failed" : "attested";
      await deps.update(id, { status, attempts, lastError: message, mintTxHash: undefined });
      if (status === "failed") await alertBridgeFailed(record, bridge, message, deps);
      return status;
    }

    const isExpiredAttestation =
      typeof error?.message === "string" && error.message.includes("expired");
    if (isExpiredAttestation && record.attestationMessage) {
      try {
        await deps.reattest(record.attestationMessage);
        await deps.update(id, {
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
    const failed = attempts >= MAX_ATTEMPTS;
    await deps.update(id, {
      attempts,
      lastError: message,
      status: failed ? "failed" : record.status,
    });
    if (failed && bridge) await alertBridgeFailed(record, bridge, message, deps);
    return failed ? "failed" : record.status;
  }
}

type BridgeMetaOf = NonNullable<CctpTransferRecord["bridge"]>;

function bridgeDest(record: CctpTransferRecord) {
  return bridgeChainByDomain(record.destDomain);
}

/** A Fast quote whose attestation was only issued at Standard finality. */
function fellBackToStandard(speed: BridgeMetaOf["speed"], messageHex: string): boolean {
  if (speed !== "fast") return false;
  try {
    return parseCctpMessage(messageHex).finalityThresholdExecuted >= FINALITY_THRESHOLD.standard;
  } catch {
    return false;
  }
}

function isGasFloorError(error: unknown): boolean {
  return (
    error instanceof CctpBaseGasError ||
    error instanceof CctpGasError ||
    error instanceof SolanaGasError
  );
}

/** Dispatch a bridge mint by the destination chain's family. */
async function submitBridgeMint(
  record: CctpTransferRecord,
  bridge: BridgeMetaOf,
  params: MintParams,
  deps: AdvanceDeps,
): Promise<string | null> {
  const dest = bridgeDest(record);
  switch (dest.family) {
    case "evm":
      return deps.submitEvmMint(dest.key as EvmChainKey, params);
    case "stellar":
      return deps.submitStellarBridgeMint(params);
    case "solana": {
      // The message mints to this ATA (the 32-byte mintRecipient).
      const recipientAta = new PublicKey(
        Buffer.from(record.mintRecipient.replace(/^0x/i, ""), "hex"),
      ).toBase58();
      // Create it only when we know the owning wallet and it derives to
      // exactly this ATA; a bare token-account recipient is never created.
      const owner =
        bridge.recipient && !bridge.recipientIsTokenAccount && !bridge.recipientUnknown
          ? bridge.recipient
          : undefined;
      const ownsAta =
        owner !== undefined && safeDeriveAta(owner) === recipientAta;
      return deps.submitSolanaMint({
        ...params,
        recipientAta,
        createAta: ownsAta,
        ...(ownsAta ? { recipientOwner: owner } : {}),
      });
    }
  }
}

function safeDeriveAta(owner: string): string | null {
  try {
    return deriveUsdcAta(owner, BRIDGE_CHAINS.solana.usdc);
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function alertBridgeFailed(
  record: CctpTransferRecord,
  bridge: BridgeMetaOf,
  lastError: string,
  deps: AdvanceDeps,
): Promise<void> {
  try {
    await deps.notify(
      [
        "<b>Bridge transfer failed</b>",
        `ID: <code>${escapeHtml(record.id)}</code>`,
        `Route: ${escapeHtml(bridge.source)} → ${escapeHtml(bridge.dest)}`,
        `Last error: ${escapeHtml(lastError.slice(0, 500))}`,
      ].join("\n"),
      "critical",
    );
  } catch {
    // Best-effort: alerting must never change the transfer's outcome.
  }
}
