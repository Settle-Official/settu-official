"use client";

import { useCallback, useEffect, useState } from "react";
import type { OfframpTransactionRecord } from "@/lib/offramp/transaction-history";
import { TransactionStorage, type Transaction } from "@/lib/transaction-storage";

export interface HistoryRow {
  readonly id: string;
  readonly kind: "offramp" | "onramp";
  /** Only the browser that started it knows this; absent on server-only rows. */
  readonly initiator?: "form" | "agent";
  /** USDC moved. 0 when not yet known (an onramp still awaiting its rate). */
  readonly usdc: number;
  readonly fiatAmount?: string;
  readonly currency: string;
  readonly status: Transaction["status"];
  readonly timestamp: number;
  readonly sourceChain?: string;
  readonly bank?: string;
  readonly accountName?: string;
  readonly accountNumber?: string;
  readonly txHash?: string;
  readonly orderId?: string;
  /** Where this row came from — "server" rows are authoritative. */
  readonly source: "server" | "local";
  readonly error?: string;
}

const num = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function fromServer(r: OfframpTransactionRecord): HistoryRow {
  return {
    id: r.id,
    kind: "offramp",
    usdc: num(r.amountUsdc),
    fiatAmount: r.destinationAmount,
    currency: r.destinationCurrency,
    status: r.status,
    timestamp: r.createdAt,
    sourceChain: r.sourceChain,
    txHash: r.burnTxHash ?? r.id,
    orderId: r.paycrestOrderId,
    source: "server",
  };
}

function fromLocal(tx: Transaction): HistoryRow {
  return {
    id: tx.id,
    // Rows written before `kind` existed were all offramps.
    kind: tx.kind ?? "offramp",
    initiator: tx.initiator,
    usdc: num(tx.amount),
    fiatAmount: tx.fiatAmount,
    currency: tx.currency,
    status: tx.status,
    timestamp: tx.timestamp,
    bank: tx.beneficiary?.institution,
    accountName: tx.beneficiary?.accountName,
    accountNumber: tx.beneficiary?.accountIdentifier,
    txHash: tx.stellarTxHash,
    orderId: tx.payoutOrderId,
    source: "local",
    error: tx.error,
  };
}

/**
 * Merge: server rows win, local rows fill the gaps.
 *
 * Redis holds every offramp this wallet ever made, on any device, but knows
 * nothing about onramps (no per-address index) and nothing about which
 * surface started a transaction. The local store knows both but only for
 * this browser, so it supplies onramp rows outright and lends its
 * `initiator` + beneficiary details to the server rows it matches.
 *
 * KNOWN GAP (not a UI bug — flagging, not silently working around): the
 * server record's own `status` is unreliable. `updateTransactionStatus` in
 * transaction-history.ts is exported but never called anywhere, so a
 * CCTP-bridge offramp (register-burn.ts) is written "pending" and stays
 * "pending" in Redis forever, even once it settles. A Base-direct offramp
 * (base-direct-register/route.ts) is written "completed" immediately at
 * registration, before the payout is actually known to have landed. Verified
 * against the live store: 10 of 17 recorded offramps are stuck at "pending",
 * and the other 7 (all Base) were marked "completed" at creation. This
 * function papers over it for same-device rows by preferring the local
 * store's status (which *is* kept in sync by the flow's own terminal
 * events), but a wallet's history read from a second device has no accurate
 * status for any transaction it didn't run — fixing that for real means
 * wiring updateTransactionStatus into the actual settlement/finalize paths
 * ("register-burn"/"base-direct-register" completion), which is a
 * backend-correctness change outside this redesign's UI-only scope.
 */
function merge(server: HistoryRow[], local: HistoryRow[]): HistoryRow[] {
  const byOrder = new Map(local.filter((r) => r.orderId).map((r) => [r.orderId!, r]));
  const byHash = new Map(local.filter((r) => r.txHash).map((r) => [r.txHash!, r]));

  const matched = new Set<string>();
  const rows = server.map((row) => {
    const local =
      (row.orderId && byOrder.get(row.orderId)) || (row.txHash && byHash.get(row.txHash)) || null;
    if (!local) return row;
    matched.add(local.id);
    return {
      ...row,
      // The server's `status` is not reliable — see the note below — so
      // prefer local's whenever this browser was the one that ran the
      // flow; it's driven by the terminal event, not stale by design.
      status: local.status,
      initiator: local.initiator,
      bank: local.bank,
      accountName: local.accountName,
      accountNumber: local.accountNumber,
      // The server fills destinationAmount in later; prefer whichever is known.
      fiatAmount: row.fiatAmount ?? local.fiatAmount,
    };
  });

  for (const row of local) {
    if (!matched.has(row.id)) rows.push(row);
  }
  return rows.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * A wallet's transaction history: the permanent server record merged with
 * this browser's own rows. `isLoading` is only true while the first server
 * read is in flight — local rows render immediately.
 */
export function useWalletHistory(address: string | undefined) {
  const [local, setLocal] = useState<HistoryRow[]>([]);
  const [server, setServer] = useState<HistoryRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readLocal = useCallback(() => {
    setLocal(address ? TransactionStorage.getByUser(address).map(fromLocal) : []);
  }, [address]);

  useEffect(() => {
    readLocal();
    if (!address) return;
    // Another tab (or this page's own flow) may have written a row.
    window.addEventListener("storage", readLocal);
    window.addEventListener("focus", readLocal);
    return () => {
      window.removeEventListener("storage", readLocal);
      window.removeEventListener("focus", readLocal);
    };
  }, [address, readLocal]);

  useEffect(() => {
    if (!address) {
      setServer([]);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    fetch(`/api/history/${encodeURIComponent(address)}`)
      .then((res) => res.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.error) throw new Error(payload.error);
        const records: OfframpTransactionRecord[] = payload?.data?.offramp ?? [];
        setServer(records.map(fromServer));
      })
      .catch((e: unknown) => {
        // Keep showing local rows rather than an empty screen.
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load history");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  return { rows: merge(server, local), isLoading, error, refresh: readLocal };
}
