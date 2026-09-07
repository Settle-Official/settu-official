"use client";

import { useState, useEffect, useCallback } from "react";
import { FormCard, type GasFeeOptions } from "@/components/FormCard";
import { Header } from "@/components/Header";
import { ProgressSteps } from "@/components/ProgressSteps";
import { RecentTransactionsTable } from "@/components/RecentTransactionsTable";
import { RightPanel, type PlatformStats } from "@/components/RightPanel";
import { PlatformStatsCard } from "@/components/PlatformStatsCard";
import { OnrampPanel } from "@/components/OnrampPanel";
import { useStellarWallet } from "@/hooks/useStellarWallet";
import { TransactionStorage, Transaction } from "@/lib/transaction-storage";
import { ErrorToast } from "@/components/ErrorToast";
import {
  TransactionProgressModal,
  type OfframpStep,
} from "@/components/TransactionProgressModal";
import * as StellarSdk from "@stellar/stellar-sdk";

/** Run a promise with a timeout. Rejects with a clear message on expiry. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_key, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    );
  } catch {
    return String(value);
  }
}

function decodeTxResultCode(errorResultXdr?: string): string | null {
  if (!errorResultXdr) return null;
  try {
    const txResult = StellarSdk.xdr.TransactionResult.fromXDR(
      errorResultXdr,
      "base64",
    );
    const txCode = txResult.result().switch().name;
    const opResults = txResult.result().results();
    const firstOpCode =
      opResults && opResults.length > 0
        ? opResults[0]?.tr()?.switch()?.name
        : undefined;
    return firstOpCode ? `${txCode}/${firstOpCode}` : txCode;
  } catch {
    return null;
  }
}

function formatSorobanError(payload: any): string {
  if (!payload) return "Unknown Soroban error";
  const txCode = decodeTxResultCode(payload.errorResultXdr);
  const status = payload.status ? `status=${payload.status}` : null;
  const code = txCode ? `txCode=${txCode}` : null;
  const message =
    payload.error?.message ||
    payload.errorResult?.message ||
    payload.detail ||
    null;
  const raw = safeJson(payload);
  return [status, code, message, `raw=${raw}`].filter(Boolean).join(" | ");
}

/**
 * Submit a signed Soroban XDR via the server route and wait for confirmation,
 * polling the lightweight tx-status endpoint on PENDING. Extracted so CCTP's
 * approve-then-burn flow can run this exact sequence twice instead of once.
 */
async function submitAndConfirmSoroban(signedXdr: string): Promise<string> {
  const submitAbort = new AbortController();
  const submitTimer = setTimeout(() => submitAbort.abort(), 15_000);
  let submitResponse: Response;
  try {
    submitResponse = await fetch("/api/offramp/bridge/submit-soroban", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: submitAbort.signal,
      body: JSON.stringify({ signedXdr }),
    });
  } catch (fetchErr: any) {
    if (fetchErr?.name === "AbortError") {
      throw new Error("Submit transaction timed out (15s). Please try again.");
    }
    throw new Error(`Submit transaction network error: ${fetchErr.message}`);
  } finally {
    clearTimeout(submitTimer);
  }

  const submitPayload = await submitResponse.json().catch(() => ({}));
  if (!submitResponse.ok) {
    throw new Error(
      submitPayload?.error ||
        `Soroban transaction error: ${formatSorobanError(submitPayload?.details || submitPayload)}`,
    );
  }
  if (!submitPayload?.hash) {
    throw new Error(`Soroban submit missing hash: ${safeJson(submitPayload)}`);
  }

  const txHash: string = submitPayload.hash;
  if (submitPayload.status === "SUCCESS") return txHash;
  if (submitPayload.status !== "PENDING") {
    throw new Error(
      `Transaction not confirmed (status: ${submitPayload?.status}). ` +
        (submitPayload?.error || "Please try again."),
    );
  }

  const maxPollAttempts = 30; // 30 × 3s = 90s
  for (let i = 0; i < maxPollAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await fetch(`/api/offramp/bridge/tx-status/${txHash}`);
    const statusData = await statusRes.json().catch(() => ({}));
    if (statusData?.status === "SUCCESS") return txHash;
    if (statusData?.status === "FAILED") {
      throw new Error("Transaction failed on-chain. Your wallet was not debited.");
    }
    // NOT_FOUND — keep polling
  }
  throw new Error(
    "Transaction was not confirmed within 90s. It may have expired. Your wallet was likely not debited.",
  );
}

/**
 * Register a confirmed CCTP burn so the backend can attest+mint it — the
 * only link between "burn succeeded on Stellar" and "USDC actually reaches
 * Paycrest's receive address". A burn with no successful registration is
 * cryptographically stuck: Circle will attest it, but nothing ever submits
 * the mint, and the mint recipient is fixed at burn time — it can't be
 * redirected or re-burned onto a fresh order. This happened for real: a
 * single unretried fetch(...).catch(()=>{}) here silently ate a transient
 * failure and orphaned a user's 9 USDC, burned but never minted, discovered
 * only when Paycrest's order expired unpaid.
 *
 * Retries a few times (the server route is idempotent — see
 * register-transfer/route.ts — so a retry after an ambiguous failure, e.g.
 * the first attempt actually succeeded but the response never arrived,
 * can't corrupt an already-advancing transfer). If every attempt still
 * fails, falls back to navigator.sendBeacon, which the browser can deliver
 * even as the page is unloading (a closed/backgrounded tab is a real way
 * for the plain retries above to never get a chance to run at all).
 *
 * Never throws — this must not block the rest of the offramp flow (the SSE
 * stream open + status polling that follow), same as the fire-and-forget
 * intent of the code this replaces.
 */
async function registerBridgeTransfer(payload: {
  burnTxHash: string;
  mintRecipient: string;
  amount: string;
  paycrestOrderId: string;
}): Promise<void> {
  const attempts = 3;
  const delaysMs = [1000, 3000];
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch("/api/offramp/bridge/register-transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
    } catch {
      // network error — fall through to retry/backoff below
    }
    if (i < delaysMs.length) {
      await new Promise((resolve) => setTimeout(resolve, delaysMs[i]));
    }
  }
  // Every plain attempt failed. Last resort: sendBeacon survives page
  // unload/backgrounding better than fetch, though it's fire-and-forget
  // with no way to confirm delivery.
  try {
    navigator.sendBeacon?.(
      "/api/offramp/bridge/register-transfer",
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
    );
  } catch {
    // Nothing more we can do client-side. There is currently no server-side
    // backstop that independently detects an unregistered burn (that would
    // mean scanning Stellar for deposit_for_burn events against every open
    // order's known receive address, e.g. via OrderMeta.receiveAddress) — a
    // real gap this doesn't close, just makes much less likely to matter.
  }
}

export function StellarampDashboard() {
  const {
    wallet,
    isConnected,
    isConnecting,
    connect,
    disconnect,
    signTransaction,
  } = useStellarWallet();

  const [mode, setMode] = useState<"offramp" | "onramp">("offramp");
  const [currentTxId, setCurrentTxId] = useState<string | null>(null);
  const [isExecutingOfframp, setIsExecutingOfframp] = useState(false);
  const [formResetKey, setFormResetKey] = useState(0);
  const [offrampStep, setOfframpStep] = useState<OfframpStep>("idle");
  const [offrampError, setOfframpError] = useState<string | null>(null);
  const [toastError, setToastError] = useState<string | null>(null);
  const [showProgressModal, setShowProgressModal] = useState(false);
  const [tradeState, setTradeState] = useState<{
    stellarTxHash?: string;
    bridgeStatus?: string;
    payoutOrderId?: string;
    payoutStatus?: string;
    error?: string;
  }>({});
  const [userTransactions, setUserTransactions] = useState<Transaction[]>([]);
  const [stellarUsdcBalance, setStellarUsdcBalance] = useState<string | null>(
    null,
  );
  const [stellarXlmBalance, setStellarXlmBalance] = useState<string | null>(
    null,
  );
  const [stellarSubentryCount, setStellarSubentryCount] = useState<
    number | null
  >(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [pricingState, setPricingState] = useState<{
    amount: string;
    quote: {
      destinationAmount: string;
      rate: number;
      currency: string;
      estimatedTimeMs: number;
    } | null;
    isLoadingQuote: boolean;
    currency: string;
    gasFeeOptions: GasFeeOptions | null;
  }>({
    amount: "",
    quote: null,
    isLoadingQuote: false,
    currency: "NGN",
    gasFeeOptions: null,
  });

  const [platformStats, setPlatformStats] = useState<PlatformStats | null>(null);

  // Fetch stats on mount
  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setPlatformStats)
      .catch(() => {});
  }, []);

  // The onramp completion itself is recorded server-side (finalizeOnrampOrder
  // pushes to the live transactions feed regardless of what detected
  // delivery — cron, SSE, or a manual retry/status check). This just
  // refreshes the client's view of that already-written state.
  const handleOnrampDelivered = useCallback(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setPlatformStats)
      .catch(() => {});
  }, []);

  // Load user transactions when wallet connects
  useEffect(() => {
    if (wallet?.publicKey) {
      const txs = TransactionStorage.getByUser(wallet.publicKey);
      setUserTransactions(txs);
    }
  }, [wallet?.publicKey]);

  // Load connected wallet USDC balance from Stellar Horizon
  useEffect(() => {
    const loadUsdcBalance = async () => {
      if (!wallet?.publicKey) {
        setStellarUsdcBalance(null);
        setStellarXlmBalance(null);
        setStellarSubentryCount(null);
        return;
      }

      setIsLoadingBalance(true);
      try {
        const response = await fetch(
          `https://horizon.stellar.org/accounts/${wallet.publicKey}`,
        );
        if (!response.ok) {
          throw new Error(`Horizon account request failed: ${response.status}`);
        }

        const account = await response.json();
        const balances = Array.isArray(account?.balances)
          ? account.balances
          : [];
        const preferredIssuer = process.env.NEXT_PUBLIC_STELLAR_USDC_ISSUER;

        // Find USDC balance
        const usdcTrustline = balances.find((balance: any) => {
          if (
            balance?.asset_type !== "credit_alphanum4" &&
            balance?.asset_type !== "credit_alphanum12"
          ) {
            return false;
          }
          if (balance?.asset_code !== "USDC") return false;
          if (preferredIssuer) return balance?.asset_issuer === preferredIssuer;
          return true;
        });

        const parsed = Number.parseFloat(usdcTrustline?.balance ?? "0");
        const displayValue = Number.isFinite(parsed)
          ? parsed.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 6,
            })
          : "0.00";
        setStellarUsdcBalance(displayValue);

        // Find XLM (native) balance
        const nativeBalance = balances.find(
          (balance: any) => balance?.asset_type === "native",
        );
        const xlmParsed = Number.parseFloat(nativeBalance?.balance ?? "0");
        const xlmDisplay = Number.isFinite(xlmParsed)
          ? xlmParsed.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 4,
            })
          : "0.00";
        setStellarXlmBalance(xlmDisplay);

        const subentryCount = Number.parseInt(account?.subentry_count, 10);
        setStellarSubentryCount(
          Number.isFinite(subentryCount) ? subentryCount : null,
        );
      } catch (error) {
                setStellarUsdcBalance("0.00");
        setStellarXlmBalance("0.00");
        setStellarSubentryCount(null);
      } finally {
        setIsLoadingBalance(false);
      }
    };

    loadUsdcBalance();
  }, [wallet?.publicKey]);

  // One path for every platform — the kit's modal picks the wallet and handles
  // extension, in-app browser and mobile deep-link transports itself.
  const handleConnect = async () => {
    try {
      const connected = await connect();
      if (connected?.publicKey) {
        fetch("/api/stats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet: connected.publicKey }),
        })
          .then((r) => r.json())
          .then(setPlatformStats)
          .catch(() => {});
      }
    } catch (error: any) {
      // Surface real connect failures. This used to be swallowed, which turned
      // any misconfiguration into a silent no-op — the hardest kind of bug to
      // report. Closing the wallet picker is a normal action, not a failure,
      // so that one stays quiet.
      const message: string = error?.message || "Failed to connect wallet";
      const isUserCancelled =
        /reject|denied|cancel|closed|dismiss|user (closed|declined)/i.test(
          message,
        );
      if (!isUserCancelled) setToastError(message);
    }
  };

  const handleDisconnect = async () => {
    await disconnect();
    setUserTransactions([]);
  };

  const handleExecuteTrade = async (tradeData: {
    amount: string;
    rate: number;
    token: string;
    beneficiary: {
      institution: string;
      accountIdentifier: string;
      accountName: string;
      currency: string;
      memo?: string;
    };
  }) => {
    if (!wallet) {
      throw new Error("Wallet not connected");
    }
    if (!pricingState.quote) {
      setToastError("Quote unavailable. Please enter an amount first.");
      return;
    }

    // Pre-flight: check USDC balance
    const usdcBal = parseFloat((stellarUsdcBalance ?? "0").replace(/,/g, ""));
    const sendAmount = parseFloat(tradeData.amount);
    if (usdcBal < sendAmount) {
      setToastError(
        `Insufficient USDC balance. You have ${usdcBal.toFixed(2)} USDC but are trying to send ${sendAmount} USDC.`,
      );
      return;
    }

    // Pre-flight: every CCTP offramp submits at least one Soroban transaction
    // (the burn — plus an approve tx the first time, or after allowance is
    // exhausted), always paid in XLM as Stellar's own network fee. Unlike the
    // old Allbridge relayer fee, there's no separate bridge-side XLM charge
    // to quote in advance — the bridge fee is always USDC, deducted from the
    // amount (shown above). This check only needs to cover Stellar's real
    // account reserve plus a conservative buffer for network fees.
    if (stellarSubentryCount === null) {
      setToastError(
        "Still loading account data — please wait a moment and try again.",
      );
      return;
    }
    // Stellar's base reserve (0.5 XLM per subentry, 2 base reserves minimum)
    // has been a stable, unchanged network parameter for years.
    const STELLAR_BASE_RESERVE_XLM = 0.5;
    const minReserve = (2 + stellarSubentryCount) * STELLAR_BASE_RESERVE_XLM;
    // Soroban resource fees are typically a small fraction of an XLM; this
    // covers an approve tx + a burn tx with comfortable headroom.
    const NETWORK_FEE_BUFFER_XLM = 0.5;
    const xlmBal = parseFloat((stellarXlmBalance ?? "0").replace(/,/g, ""));
    const needed = minReserve + NETWORK_FEE_BUFFER_XLM;
    if (xlmBal < needed) {
      setToastError(
        `Insufficient XLM. You have ${xlmBal.toFixed(2)} XLM but need ~${needed.toFixed(2)} XLM (${minReserve.toFixed(1)} account reserve + network fees). Add more XLM to your wallet.`,
      );
      return;
    }

    const baseReturnAddress = process.env.NEXT_PUBLIC_BASE_RETURN_ADDRESS;
    if (!baseReturnAddress) {
      throw new Error("NEXT_PUBLIC_BASE_RETURN_ADDRESS is missing");
    }

    const txId = TransactionStorage.generateId();
    setCurrentTxId(txId);
    setIsExecutingOfframp(true);
    setOfframpStep("initiating");
    setOfframpError(null);
    setShowProgressModal(true);

    // Create initial transaction record
    const transaction: Transaction = {
      id: txId,
      timestamp: Date.now(),
      userAddress: wallet.publicKey,
      amount: tradeData.amount,
      currency: "NGN",
      beneficiary: tradeData.beneficiary,
      status: "pending",
    };
    TransactionStorage.save(transaction);
    setUserTransactions(TransactionStorage.getByUser(wallet.publicKey));

    try {
      setTradeState({ bridgeStatus: "building", payoutStatus: "pending" });

      // 1) Compute post-bridge amount for Paycrest order amount
      const bridgeQuoteResponse = await withTimeout(
        fetch("/api/offramp/bridge/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: tradeData.amount }),
        }),
        15_000,
        "Bridge quote",
      );
      if (!bridgeQuoteResponse.ok) {
        const payload = await bridgeQuoteResponse.json().catch(() => ({}));
        throw new Error(
          payload?.error ||
            `Bridge quote request failed: ${bridgeQuoteResponse.status}`,
        );
      }
      const bridgeQuotePayload = await bridgeQuoteResponse.json();
      const paycrestOrderAmount = Number.parseFloat(
        bridgeQuotePayload?.receiveAmount,
      );
      if (!Number.isFinite(paycrestOrderAmount) || paycrestOrderAmount <= 0) {
        throw new Error("Invalid bridge receive amount for payout order");
      }
      // Floor to 6 decimals to ensure actual bridge deposit >= order amount.
      // Using toFixed(6) can round UP, causing a tiny overshoot that prevents
      // Paycrest from matching the deposit to the order.
      const normalizedOrderAmount = Math.floor(paycrestOrderAmount * 1e6) / 1e6;
      const normalizedRate = Number(tradeData.rate.toFixed(6));

      // 2) Create Paycrest order first via internal API route (avoids browser CORS/key exposure)
      const orderAbort = new AbortController();
      const orderTimer = setTimeout(() => orderAbort.abort(), 20_000);
      let orderResponse: Response;
      try {
        orderResponse = await fetch("/api/offramp/paycrest/order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: orderAbort.signal,
          body: JSON.stringify({
            amount: normalizedOrderAmount,
            token: tradeData.token,
            network: "base",
            rate: normalizedRate,
            reference: txId,
            recipient: {
              institution: tradeData.beneficiary.institution,
              accountIdentifier: tradeData.beneficiary.accountIdentifier,
              accountName: tradeData.beneficiary.accountName,
              memo: tradeData.beneficiary.memo || "Settu offramp",
              currency: tradeData.beneficiary.currency,
            },
            returnAddress: baseReturnAddress,
          }),
        });
      } catch (fetchErr: any) {
        if (fetchErr?.name === "AbortError") {
          throw new Error(
            "Paycrest order request timed out (20s). Please try again.",
          );
        }
        throw new Error(`Paycrest order network error: ${fetchErr.message}`);
      } finally {
        clearTimeout(orderTimer);
      }
      if (!orderResponse.ok) {
        const payload = await orderResponse.json().catch(() => ({}));
        const details =
          payload?.details && typeof payload.details === "object"
            ? ` | details=${JSON.stringify(payload.details)}`
            : payload?.details
              ? ` | details=${String(payload.details)}`
              : "";
        throw new Error(
          `${payload?.message || payload?.error || `Paycrest order failed: ${orderResponse.status}`}${details}`,
        );
      }
      const orderPayload = await orderResponse.json();
      const paycrestOrder = orderPayload?.data || orderPayload;
      const payoutOrderId: string | undefined = paycrestOrder?.id;
      const settlementAddress: string | undefined =
        paycrestOrder?.receiveAddress;
      if (!payoutOrderId || !settlementAddress) {
        throw new Error("Paycrest order response missing id/receiveAddress");
      }
      setTradeState((prev) => ({
        ...prev,
        payoutOrderId,
        payoutStatus: "pending",
      }));
      TransactionStorage.update(txId, {
        payoutOrderId,
        payoutStatus: "pending",
      });
      setUserTransactions(TransactionStorage.getByUser(wallet.publicKey));

      // 3) Build CCTP burn tx to Paycrest settlement wallet (server route to
      // avoid client RPC issues) — may require an approve step first.
      const buildBurnTxPayload = async () => {
        const buildAbort = new AbortController();
        const buildTimer = setTimeout(() => buildAbort.abort(), 30_000);
        try {
          const res = await fetch("/api/offramp/bridge/build-tx", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: buildAbort.signal,
            body: JSON.stringify({
              amount: tradeData.amount,
              fromAddress: wallet.publicKey,
              toAddress: settlementAddress,
            }),
          });
          if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            throw new Error(
              payload?.error || `Failed to build bridge transaction: ${res.status}`,
            );
          }
          return res.json();
        } catch (fetchErr: any) {
          if (fetchErr?.name === "AbortError") {
            throw new Error("Build transaction timed out (30s). Please try again.");
          }
          throw fetchErr;
        } finally {
          clearTimeout(buildTimer);
        }
      };

      let buildTxPayload = await buildBurnTxPayload();

      if (buildTxPayload.needsApproval) {
        setOfframpStep("awaiting-signature");
        const signedApprove = await signTransaction(buildTxPayload.approveXdr);
        setOfframpStep("submitting");
        await submitAndConfirmSoroban(signedApprove);

        // Re-request now that allowance is sufficient.
        buildTxPayload = await buildBurnTxPayload();
      }

      const xdr: string | undefined = buildTxPayload?.xdr;
      if (!xdr) {
        throw new Error("Bridge transaction payload missing XDR");
      }

      // 4) Sign and submit the burn
      setOfframpStep("awaiting-signature");
      const signedXdr = await signTransaction(xdr);
      setOfframpStep("submitting");

      let stellarTxHash: string;
      let hasSorobanOps = true;
      let signedTx:
        | StellarSdk.Transaction
        | StellarSdk.FeeBumpTransaction
        | null = null;
      try {
        signedTx = StellarSdk.TransactionBuilder.fromXDR(
          signedXdr,
          StellarSdk.Networks.PUBLIC,
        );
        if ("operations" in signedTx) {
          hasSorobanOps = signedTx.operations.some(
            (op: any) => op.type === "invokeHostFunction",
          );
        }
      } catch (parseErr) {
              }

      if (hasSorobanOps) {
        stellarTxHash = await submitAndConfirmSoroban(signedXdr);
      } else if (signedTx) {
        // Classic tx path
        const server = new StellarSdk.Horizon.Server(
          "https://horizon.stellar.org",
        );
        const result = await server.submitTransaction(signedTx);
        stellarTxHash = result.hash;
      } else {
        throw new Error("Unable to parse or submit signed transaction");
      }

      setTradeState((prev) => ({
        ...prev,
        stellarTxHash,
        bridgeStatus: "pending",
      }));

      // 5) Register the transfer (creates the CctpTransferRecord + ledger
      // entry) and open the SSE stream so attest-to-mint is driven forward
      // while this tab is open. This is NOT mere operational bookkeeping —
      // it's the only thing that will ever get this burn minted to
      // Paycrest's receive address at all, since the mint recipient was
      // fixed at burn time and can't be redirected or re-burned onto a new
      // order. Paycrest's payout webhook can only fire once that mint has
      // actually landed there, so a failed registration here doesn't just
      // lose tracking — it strands the burn permanently. registerBridgeTransfer
      // retries and falls back to sendBeacon accordingly; still awaited
      // (not truly fire-and-forget) so the UI doesn't move on before at
      // least the first attempt has had a chance to land.
      await registerBridgeTransfer({
        burnTxHash: stellarTxHash,
        mintRecipient: settlementAddress,
        amount: tradeData.amount,
        paycrestOrderId: payoutOrderId,
      });
      new EventSource(`/api/offramp/bridge/stream/${stellarTxHash}`);

      // Update transaction with tx hash
      TransactionStorage.update(txId, {
        stellarTxHash,
        bridgeStatus: "pending",
      });
      setUserTransactions(TransactionStorage.getByUser(wallet.publicKey));

      // 6) Poll bridge + payout status independently.
      setOfframpStep("processing");
      // Bridge polling is best-effort — Allbridge status API may 404 for a while.
      // Payout polling is what actually matters (Paycrest settling to the bank).
      const bridgeResult = pollBridgeStatus(txId, stellarTxHash).catch(
        (err) => {
                    // Don't fail the overall flow — bridge may still complete in background
        },
      );
      const payoutResult = pollPayoutStatus(txId, payoutOrderId);

      // Switch to "settling" once bridge is likely done (after a short delay)
      bridgeResult.then(() => {
        setOfframpStep((prev) => (prev === "processing" ? "settling" : prev));
      });

      // Payout settlement is the critical path — once fiat arrives, we're done.
      // Bridge polling is best-effort background info; don't block success on it.
      await payoutResult;

      // Mark as completed immediately — bridge may still be polling in background
      setOfframpStep("success");
      TransactionStorage.update(txId, { status: "completed" });
      setUserTransactions(TransactionStorage.getByUser(wallet.publicKey));

      // The offramp completion itself is now recorded server-side (the
      // Paycrest webhook pushes to the live transactions feed + volume on
      // `settled`, regardless of whether this tab is still open). Just
      // refresh the client's view of that already-written state.
      fetch("/api/stats")
        .then((r) => r.json())
        .then(setPlatformStats)
        .catch(() => {});

      // Reset the form so the user can start a fresh offramp
      setFormResetKey((k) => k + 1);
    } catch (error: any) {
      
      // Log detailed Horizon error if available
      if (error?.response?.data) {
              }

      setTradeState((prev) => ({ ...prev, error: error.message }));
      setOfframpStep("error");
      setOfframpError(error.message);

      // Mark as failed
      TransactionStorage.update(txId, {
        status: "failed",
        error: error.message,
      });
      setUserTransactions(TransactionStorage.getByUser(wallet.publicKey));

      // Don't re-throw — the modal already shows the error to the user.
      // Re-throwing would cause an unhandled promise rejection.
    } finally {
      setIsExecutingOfframp(false);
      setCurrentTxId(null);
      // Don't close modal or reset step here — user dismisses modal manually
    }
  };

  const pollBridgeStatus = async (txId: string, txHash: string) => {
    const maxAttempts = 60;
    let attempts = 0;
    let consecutiveErrors = 0;
    const MAX_ERRORS = 10; // give up after 10 consecutive errors

    while (attempts < maxAttempts) {
      try {
        const response = await fetch(`/api/offramp/bridge/status/${txHash}`);
        if (!response.ok) {
          consecutiveErrors++;
                    if (consecutiveErrors >= MAX_ERRORS) {
                        return; // soft exit — don't throw
          }
          await new Promise((resolve) => setTimeout(resolve, 10000));
          attempts++;
          continue;
        }

        consecutiveErrors = 0; // reset on success
        const payload = await response.json();
        const status = payload?.data || payload;

        setTradeState((prev) => ({ ...prev, bridgeStatus: status.status }));
        TransactionStorage.update(txId, { bridgeStatus: status.status });
        setUserTransactions(TransactionStorage.getByUser(wallet!.publicKey));

        if (status.status === "completed") return;
        if (status.status === "failed")
          throw new Error("Bridge transfer failed");
      } catch (error: any) {
        if (error?.message === "Bridge transfer failed") throw error;
        consecutiveErrors++;
                if (consecutiveErrors >= MAX_ERRORS) {
                    return; // soft exit
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
      attempts++;
    }

    // Timeout is NOT fatal — bridge may still complete
      };

  const pollPayoutStatus = (txId: string, orderId: string) => {
    // Webhook-driven: the server persists Paycrest events to Redis and streams
    // them here over SSE. Resolve only on "settled"; reject ONLY on a positive
    // failure signal ("refunded"/"expired"). A dropped stream is *unknown*, not
    // failed — we reconnect and, as a backstop, poll the status endpoint. This
    // avoids showing "failed" when the payout actually succeeded but the stream
    // closed (Vercel maxDuration, network blip) before delivering "settled".
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let source: EventSource | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        settled = true;
        source?.close();
        source = null;
        if (pollTimer) clearInterval(pollTimer);
      };

      const applyStatus = (status: string): "resolve" | "reject" | null => {
        setTradeState((prev) => ({ ...prev, payoutStatus: status }));
        TransactionStorage.update(txId, { payoutStatus: status });
        setUserTransactions(TransactionStorage.getByUser(wallet!.publicKey));

        // Advance the modal to "settling" once the deposit is validated or the
        // onchain release is underway.
        if (
          status === "validated" ||
          status === "settling" ||
          status === "settled"
        ) {
          setOfframpStep((prev) =>
            prev === "processing" || prev === "settling" ? "settling" : prev,
          );
        }

        // Only "settled" means fiat landed. Only these two mean real failure.
        if (status === "settled") return "resolve";
        if (status === "refunded" || status === "expired") return "reject";
        return null;
      };

      const connect = () => {
        if (settled) return;
        source = new EventSource(`/api/offramp/stream/${orderId}`);

        source.onmessage = (evt) => {
          let record: { status?: string };
          try {
            record = JSON.parse(evt.data);
          } catch {
            return;
          }
          if (!record.status) return;
          const decision = applyStatus(record.status);
          if (decision === "resolve") {
            cleanup();
            resolve();
          } else if (decision === "reject") {
            cleanup();
            reject(new Error(`Payout ${record.status} before settlement`));
          }
        };

        source.onerror = () => {
          // A closed connection is NOT a failure. Close this handle; the
          // fallback poller below keeps checking and will reconnect implicitly
          // by continuing to read authoritative status from Redis.
          if (source && source.readyState === EventSource.CLOSED) {
            source.close();
            source = null;
            // Re-open the stream shortly, unless we've already finished.
            if (!settled) setTimeout(connect, 3000);
          }
        };
      };

      // Backstop: independent of the stream, poll the Redis-backed status
      // endpoint. This resolves/reject even if SSE never delivers the terminal
      // event (e.g. webhook wrote it but the stream had dropped at that moment).
      const poll = async () => {
        if (settled) return;
        try {
          const res = await fetch(`/api/offramp/paycrest/order/${orderId}`);
          if (!res.ok) return;
          const payload = await res.json();
          const status = (payload?.data || payload)?.status;
          if (!status) return;
          const decision = applyStatus(status);
          if (decision === "resolve") {
            cleanup();
            resolve();
          } else if (decision === "reject") {
            cleanup();
            reject(new Error(`Payout ${status} before settlement`));
          }
        } catch {
          // ignore; try again next interval
        }
      };

      connect();
      pollTimer = setInterval(poll, 12000);
    });
  };

  const getSubtitle = () => {
    if (isConnecting) return "Connecting to wallet...";
    return "Convert Stellar USDC to your bank account in minutes.";
  };

  const handlePricingUpdate = useCallback(
    (data: {
      amount: string;
      quote: {
        destinationAmount: string;
        rate: number;
        currency: string;
        estimatedTimeMs: number;
      } | null;
      isLoadingQuote: boolean;
      currency: string;
      gasFeeOptions: GasFeeOptions | null;
    }) => {
      setPricingState(data);
    },
    [],
  );

  return (
    <main className="min-h-screen p-4">
      <section className="min-h-[88vh] border border-[#1f1f1f] bg-[var(--bg)]">
        <div className="flex flex-col gap-6 px-[2.6rem] py-8 max-[720px]:p-4">
          <Header
            subtitle={getSubtitle()}
            isConnected={isConnected}
            isConnecting={isConnecting}
            walletAddress={wallet?.publicKey}
            stellarUsdcBalance={stellarUsdcBalance}
            stellarXlmBalance={stellarXlmBalance}
            isBalanceLoading={isLoadingBalance}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
          />

          <div className="flex gap-2">
            {(["onramp", "offramp"] as const).map((m) => {
              const isActive = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={isActive}
                  // Inline styles here, not bg-*/border-* utility classes: a
                  // global unlayered `button { background: none; border: 0 }`
                  // reset in globals.css always wins over layered Tailwind
                  // utilities regardless of source order, which silently
                  // dropped the active-state fill (only the focus ring showed,
                  // vanishing on blur). Inline style has the highest
                  // specificity, so it renders correctly without having to
                  // touch that global reset and risk changing every other
                  // button's look.
                  style={{
                    border: "4px solid #C9A962",
                    backgroundColor: isActive ? "#C9A962" : "#101010",
                    color: isActive ? "#0a0a0a" : "#f4e1ad",
                  }}
                  className="min-w-[150px] px-4 py-[0.6rem] text-[0.75rem] font-semibold uppercase tracking-[0.08em] rounded-none transition-colors focus:outline-none focus:ring-2 focus:ring-[#C9A962]/70"
                >
                  {m === "onramp" ? "On-ramp" : "Off-ramp"}
                </button>
              );
            })}
          </div>

          {mode === "onramp" ? (
            <div className="grid grid-cols-[1fr_370px] gap-3 max-[1100px]:grid-cols-1">
              <div className="max-[1100px]:order-1">
                <OnrampPanel
                  isConnected={isConnected}
                  isConnecting={isConnecting}
                  walletAddress={wallet?.publicKey}
                  onConnect={handleConnect}
                  onDelivered={handleOnrampDelivered}
                />
              </div>
              <div className="col-start-2 max-[1100px]:order-2 max-[1100px]:col-auto">
                <PlatformStatsCard stats={platformStats} />
              </div>
              <div className="col-start-1 max-[1100px]:order-3 max-[1100px]:col-auto">
                <RecentTransactionsTable
                  rows={platformStats?.recentTransactions ?? []}
                  isLive={true}
                />
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_370px] gap-3 max-[1100px]:grid-cols-1">
                <div className="max-[1100px]:order-1">
                  <FormCard
                    isConnected={isConnected}
                    isConnecting={isConnecting}
                    isExecutingOfframp={isExecutingOfframp}
                    resetKey={formResetKey}
                    onConnect={handleConnect}
                    onInitiateOfframp={handleExecuteTrade}
                    onPricingUpdate={handlePricingUpdate}
                  />
                </div>
                <div className="row-span-2 col-start-2 max-[1100px]:order-2 max-[1100px]:row-auto max-[1100px]:col-auto">
                  <RightPanel
                    stats={platformStats}
                    isConnected={isConnected}
                    isConnecting={isConnecting}
                    amount={pricingState.amount}
                    quote={pricingState.quote}
                    isLoadingQuote={pricingState.isLoadingQuote}
                    currency={pricingState.currency}
                    onConnect={handleConnect}
                  />
                </div>
                <div className="col-start-1 max-[1100px]:order-3 max-[1100px]:col-auto">
                  <RecentTransactionsTable
                    rows={platformStats?.recentTransactions ?? []}
                    isLive={true}
                  />
                </div>
              </div>

              <ProgressSteps
                isConnected={isConnected}
                isConnecting={isConnecting}
              />
            </>
          )}
        </div>
      </section>

      <ErrorToast message={toastError} onDismiss={() => setToastError(null)} />

      <TransactionProgressModal
        isOpen={showProgressModal}
        currentStep={offrampStep}
        error={offrampError}
        onClose={() => {
          setShowProgressModal(false);
          setOfframpStep("idle");
          setOfframpError(null);
          setTradeState({});
          setIsExecutingOfframp(false);
        }}
      />
    </main>
  );
}
