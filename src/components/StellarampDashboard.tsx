"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  FormCard,
  type GasFeeOptions,
  type OfframpSourceChainKey,
} from "@/components/FormCard";
import { Header } from "@/components/Header";
import { ProgressSteps } from "@/components/ProgressSteps";
import { RecentTransactionsTable } from "@/components/RecentTransactionsTable";
import { RightPanel, type PlatformStats } from "@/components/RightPanel";
import { PlatformStatsCard } from "@/components/PlatformStatsCard";
import { OnrampPanel } from "@/components/OnrampPanel";
import { useStellarWallet } from "@/hooks/useStellarWallet";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useSolanaWallet } from "@/hooks/useSolanaWallet";
import { Keypair } from "@solana/web3.js";
import {
  EVM_SOURCE_CHAINS,
  isCctpBridgeChain,
  type EvmChainKey,
} from "@/lib/cctp/evm-chains";
import { TransactionStorage, Transaction } from "@/lib/transaction-storage";
import { ErrorToast } from "@/components/ErrorToast";
import { EvmConnectModal } from "@/components/EvmConnectModal";
import { SolanaConnectModal } from "@/components/SolanaConnectModal";
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

/**
 * Wait for a wallet signature, but not forever.
 *
 * Mobile WalletConnect (Freighter iOS in particular) can silently drop the
 * wallet's response over the relay: the user approves, the wallet stays
 * foregrounded, and back in the browser `signTransaction` never settles —
 * the underlying WalletConnect request only rejects at its ~5-minute expiry,
 * and until then the progress modal has no way out. Cap it ourselves with an
 * actionable message. (The `redirect` metadata added to the kit's WC config
 * is the real fix for the drop; this is the backstop for when it still
 * happens.)
 */
async function signWithTimeout(
  sign: () => Promise<string>,
  ms = 150_000,
): Promise<string> {
  try {
    return await withTimeout(sign(), ms, "Wallet signature");
  } catch (err: any) {
    if (/timed out/i.test(err?.message || "")) {
      throw new Error(
        "We didn't hear back from your wallet. If you approved it, the transaction may still go through — check your recent transactions in a minute. Otherwise close this and try again (a desktop browser is more reliable for this step).",
      );
    }
    throw err;
  }
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
 * Submit a signed Soroban XDR via the server route and return the broadcast
 * tx hash as soon as the RPC accepts it (status PENDING or already SUCCESS).
 * Throws only on a genuine submit failure — an ERROR/TRY_AGAIN_LATER status,
 * a missing hash, or a network error.
 *
 * Confirmation is deliberately a SEPARATE step (`confirmSoroban`): a caller
 * that must not strand an on-chain effect — the CCTP burn, whose mint
 * recipient is fixed at burn time and can never be redirected — can persist
 * the hash and register the transfer BEFORE waiting for confirmation, so a
 * slow Soroban RPC that times out the poll can't orphan a burn that actually
 * landed. (A real incident: a burn confirmed on-chain, the 90s poll timed
 * out, the flow threw before registering, and ~10 USDC was stuck — burned
 * but with nothing to ever mint it.)
 */
async function submitSoroban(signedXdr: string): Promise<string> {
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
  if (
    submitPayload.status !== "SUCCESS" &&
    submitPayload.status !== "PENDING"
  ) {
    throw new Error(
      `Transaction not confirmed (status: ${submitPayload?.status}). ` +
        (submitPayload?.error || "Please try again."),
    );
  }
  return submitPayload.hash as string;
}

type SorobanConfirmation = "confirmed" | "failed" | "timeout";

/**
 * Poll the lightweight tx-status endpoint until a submitted Soroban tx is
 * confirmed. RETURNS the outcome rather than throwing on timeout, so the
 * caller decides what a timeout means: for an already-registered burn it's
 * just "still bridging" (the SSE stream + daily cron will finish the mint,
 * and the payout poll is the real completion signal), not a failed offramp.
 */
async function confirmSoroban(txHash: string): Promise<SorobanConfirmation> {
  const maxPollAttempts = 30; // 30 × 3s = 90s
  for (let i = 0; i < maxPollAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await fetch(`/api/offramp/bridge/tx-status/${txHash}`);
    const statusData = await statusRes.json().catch(() => ({}));
    if (statusData?.status === "SUCCESS") return "confirmed";
    if (statusData?.status === "FAILED") return "failed";
    // NOT_FOUND — keep polling
  }
  return "timeout";
}

/**
 * Submit + wait for confirmation, throwing on anything but success. Used for
 * the pre-burn approve tx, where there's no permanent-strand risk (nothing
 * is burned yet) and the caller re-checks the allowance afterwards anyway.
 */
async function submitAndConfirmSoroban(signedXdr: string): Promise<string> {
  const hash = await submitSoroban(signedXdr);
  const outcome = await confirmSoroban(hash);
  if (outcome === "failed") {
    throw new Error("Transaction failed on-chain. Your wallet was not debited.");
  }
  if (outcome === "timeout") {
    throw new Error(
      "Transaction was not confirmed within 90s. It may have expired. Your wallet was likely not debited.",
    );
  }
  return hash;
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

/**
 * The EVM-source equivalent of registerBridgeTransfer above — same reasoning
 * and shape (a confirmed on-chain burn/transfer whose registration call
 * silently fails is orphaned exactly the way a real Stellar offramp burn once
 * was). Generic over the endpoint: CCTP-bridge chains register at
 * /register-transfer (which drives the same attest/mint state machine),
 * Base's direct transfer at /base-direct-register (record-only). Never
 * throws — a registration failure must not abort the rest of the flow.
 */
async function registerEvmTransfer(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const attempts = 3;
  const delaysMs = [1000, 3000];
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(endpoint, {
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
  try {
    navigator.sendBeacon?.(
      endpoint,
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
    );
  } catch {
    // nothing more to do client-side
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

  // Parallel, independent non-Stellar wallet paths — EVM (EIP-6963 /
  // WalletConnect) and Solana (Wallet Standard). Only one wallet of the three
  // is ever connected at a time; switching the source-chain dropdown tears
  // the others down (see handleSourceChainChange).
  const evmWallet = useEvmWallet();
  const solanaWallet = useSolanaWallet();
  const [solanaConnectOpen, setSolanaConnectOpen] = useState(false);

  const [sourceChain, setSourceChain] =
    useState<OfframpSourceChainKey>("stellar");

  const isSolanaSource = sourceChain === "solana";
  const isEvmSource = sourceChain !== "stellar" && !isSolanaSource;
  const isExternalSource = isEvmSource || isSolanaSource;

  // Unified view of whichever non-Stellar wallet the current source uses.
  const externalWallet = isSolanaSource
    ? {
        isConnected: solanaWallet.isConnected,
        isConnecting: solanaWallet.isConnecting,
        address: solanaWallet.address ?? undefined,
      }
    : {
        isConnected: evmWallet.isConnected,
        isConnecting: evmWallet.isConnecting,
        address: evmWallet.address ?? undefined,
      };

  // What the offramp UI (FormCard, RightPanel, ProgressSteps) should treat as
  // "connected" / "connecting" — whichever wallet path the current source uses.
  const uiIsConnected =
    sourceChain === "stellar" ? isConnected : externalWallet.isConnected;
  const uiIsConnecting =
    sourceChain === "stellar" ? isConnecting : externalWallet.isConnecting;
  const activeUserAddress =
    sourceChain === "stellar" ? wallet?.publicKey : externalWallet.address;

  const [mode, setMode] = useState<"offramp" | "onramp">("offramp");

  // The shared top header reflects the external wallet only for an offramp
  // from a non-Stellar source; onramp is always the Stellar path.
  const headerUsesExternal = mode === "offramp" && isExternalSource;

  const activeSourceChainLabel =
    sourceChain === "stellar"
      ? "Stellar"
      : isSolanaSource
        ? "Solana"
        : (EVM_SOURCE_CHAINS[sourceChain as EvmChainKey]?.label ??
          "the source chain");
  const [currentTxId, setCurrentTxId] = useState<string | null>(null);
  const [isExecutingOfframp, setIsExecutingOfframp] = useState(false);
  const [formResetKey, setFormResetKey] = useState(0);
  const [offrampStep, setOfframpStep] = useState<OfframpStep>("idle");
  const [offrampError, setOfframpError] = useState<string | null>(null);
  // Bumped whenever an offramp starts or is cancelled. A flow whose id no
  // longer matches must not write step/error state — otherwise a signature
  // that resolves late (or a cancelled flow's WalletConnect request finally
  // expiring) clobbers the modal for whatever the user is doing now.
  const offrampFlowRef = useRef(0);
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
  // Connected non-Stellar wallet's balances on the current source chain
  // (offramp only) — for the header readout + FormCard's USDC check.
  const [externalBalances, setExternalBalances] = useState<{
    usdc: string;
    native: string;
    nativeSymbol: string;
  } | null>(null);
  // Raw numeric balances. The display strings above go through
  // toLocaleString with maximumFractionDigits: 6, but Stellar USDC carries 7
  // decimals — parsing those back can round *up* and pass a balance check the
  // wallet cannot actually cover, failing later on-chain instead. Every
  // comparison must use these.
  const [stellarUsdcBalanceRaw, setStellarUsdcBalanceRaw] = useState<
    number | null
  >(null);
  const [stellarXlmBalanceRaw, setStellarXlmBalanceRaw] = useState<
    number | null
  >(null);
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

  const [platformStats, setPlatformStats] = useState<PlatformStats | null>(
    null,
  );

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

  // Poll the connected non-Stellar wallet's balances (offramp only). EVM ->
  // evm-balances, Solana -> solana-balances; both normalised to
  // { usdc, native, nativeSymbol }.
  const externalWalletAddress = isSolanaSource
    ? solanaWallet.address
    : evmWallet.address;
  useEffect(() => {
    if (mode !== "offramp" || !isExternalSource || !externalWalletAddress) {
      setExternalBalances(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        let normalised: {
          usdc: string;
          native: string;
          nativeSymbol: string;
        } | null = null;
        if (isSolanaSource) {
          const res = await fetch(
            `/api/offramp/bridge/solana-balances?address=${externalWalletAddress}`,
          );
          if (!res.ok || cancelled) return;
          const d = await res.json();
          normalised = { usdc: d.usdc, native: d.sol, nativeSymbol: "SOL" };
        } else {
          const params = new URLSearchParams({
            address: externalWalletAddress,
            chain: sourceChain,
          });
          const res = await fetch(
            `/api/offramp/bridge/evm-balances?${params.toString()}`,
          );
          if (!res.ok || cancelled) return;
          const d = await res.json();
          normalised = {
            usdc: d.usdc,
            native: d.native,
            nativeSymbol: d.nativeSymbol,
          };
        }
        if (!cancelled) setExternalBalances(normalised);
      } catch {
        // keep whatever we had
      }
    };
    load();
    const iv = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [
    mode,
    sourceChain,
    isExternalSource,
    isSolanaSource,
    externalWalletAddress,
  ]);

  // Load connected wallet USDC balance from Stellar Horizon
  useEffect(() => {
    const loadUsdcBalance = async () => {
      if (!wallet?.publicKey) {
        setStellarUsdcBalance(null);
        setStellarXlmBalance(null);
        setStellarUsdcBalanceRaw(null);
        setStellarXlmBalanceRaw(null);
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
        setStellarUsdcBalanceRaw(Number.isFinite(parsed) ? parsed : 0);

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
        setStellarXlmBalanceRaw(Number.isFinite(xlmParsed) ? xlmParsed : 0);

        const subentryCount = Number.parseInt(account?.subentry_count, 10);
        setStellarSubentryCount(
          Number.isFinite(subentryCount) ? subentryCount : null,
        );
      } catch (error) {
        setStellarUsdcBalance("0.00");
        setStellarXlmBalance("0.00");
        setStellarUsdcBalanceRaw(null);
        setStellarXlmBalanceRaw(null);
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
    // Onramp is always Stellar; an offramp with the Stellar source keeps the
    // original Stellar Wallets Kit path below entirely unchanged. A
    // non-Stellar offramp source opens its own picker.
    if (mode === "offramp" && isSolanaSource) {
      setSolanaConnectOpen(true);
      return;
    }
    if (mode === "offramp" && isEvmSource) {
      void evmWallet.openConnect().catch((e: any) => {
        // Declining in the wallet is a normal action, not an error.
        const message = e?.message || "Failed to connect wallet";
        if (!/reject|denied|cancel|closed|dismiss/i.test(message)) {
          setToastError(message);
        }
      });
      return;
    }

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
    // Disconnect whichever wallet is actually in use — a non-Stellar path
    // only applies to an offramp; onramp is always Stellar.
    if (mode === "offramp" && isSolanaSource) {
      await solanaWallet.disconnect();
    } else if (mode === "offramp" && isEvmSource) {
      await evmWallet.disconnect();
    } else {
      await disconnect();
    }
    setUserTransactions([]);
  };

  /**
   * Switching the source chain tears down whichever wallet is currently
   * connected — Stellar / EVM / Solana can't be connected at once, and a
   * fresh connect is required for the new chain either way.
   */
  const handleSourceChainChange = async (next: OfframpSourceChainKey) => {
    if (next === sourceChain) return;
    try {
      if (sourceChain === "stellar") {
        if (isConnected) await disconnect();
      } else if (sourceChain === "solana") {
        if (solanaWallet.isConnected) await solanaWallet.disconnect();
      } else if (evmWallet.isConnected) {
        await evmWallet.disconnect();
      }
    } catch {
      // A teardown failure shouldn't block the switch — worst case a stale
      // session lingers in the other adapter until its own next connect.
    }
    setSolanaConnectOpen(false);
    setUserTransactions([]);
    setSourceChain(next);
  };

  const handleExecuteTrade = async (tradeData: {
    amount: string;
    rate: number;
    token: string;
    sourceChain: OfframpSourceChainKey;
    beneficiary: {
      institution: string;
      accountIdentifier: string;
      accountName: string;
      currency: string;
      memo?: string;
    };
  }) => {
    // Non-Stellar sources take completely separate paths — branch before any
    // of the Stellar-specific wallet/balance/XLM-reserve logic below.
    if (tradeData.sourceChain === "solana") {
      return handleExecuteSolanaTrade(tradeData);
    }
    if (tradeData.sourceChain && tradeData.sourceChain !== "stellar") {
      return handleExecuteEvmTrade(tradeData);
    }

    if (!wallet) {
      throw new Error("Wallet not connected");
    }
    if (!pricingState.quote) {
      setToastError("Quote unavailable. Please enter an amount first.");
      return;
    }

    // Pre-flight: check USDC balance against the raw figure, never the
    // formatted display string (which rounds, and can round up).
    const usdcBal = stellarUsdcBalanceRaw ?? 0;
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
    const xlmBal = stellarXlmBalanceRaw ?? 0;
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
    const myFlow = ++offrampFlowRef.current;
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
            sourceChain: tradeData.sourceChain,
            senderAddress: wallet.publicKey,
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
              payload?.error ||
                `Failed to build bridge transaction: ${res.status}`,
            );
          }
          return res.json();
        } catch (fetchErr: any) {
          if (fetchErr?.name === "AbortError") {
            throw new Error(
              "Build transaction timed out (30s). Please try again.",
            );
          }
          throw fetchErr;
        } finally {
          clearTimeout(buildTimer);
        }
      };

      let buildTxPayload = await buildBurnTxPayload();

      if (buildTxPayload.needsApproval) {
        setOfframpStep("awaiting-signature");
        const signedApprove = await signWithTimeout(() =>
          signTransaction(buildTxPayload.approveXdr),
        );
        if (offrampFlowRef.current !== myFlow) return;
        setOfframpStep("submitting");
        await submitAndConfirmSoroban(signedApprove);

        // Re-request now that the allowance should be sufficient, and bail if
        // it somehow still isn't — better a clean "try again" than a burn
        // that reverts on a zero allowance.
        buildTxPayload = await buildBurnTxPayload();
        if (buildTxPayload.needsApproval) {
          throw new Error(
            "The USDC approval didn't go through. Please try again in a moment.",
          );
        }
      }

      const xdr: string | undefined = buildTxPayload?.xdr;
      if (!xdr) {
        throw new Error("Bridge transaction payload missing XDR");
      }

      // 4) Sign and submit the burn
      setOfframpStep("awaiting-signature");
      const signedXdr = await signWithTimeout(() => signTransaction(xdr));
      if (offrampFlowRef.current !== myFlow) return;
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
      } catch (parseErr) {}

      // Whether the burn still needs its on-chain confirmation polled below.
      // The classic-tx path already waits for confirmation inside
      // submitTransaction; the Soroban path does not (by design — see below).
      let burnNeedsConfirm = false;
      if (hasSorobanOps) {
        // Get the broadcast hash — do NOT wait for confirmation here.
        stellarTxHash = await submitSoroban(signedXdr);
        burnNeedsConfirm = true;
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

      // 5) Register the transfer BEFORE confirming the burn on-chain.
      //
      // This creates the CctpTransferRecord + ledger entry and opens the SSE
      // stream that drives attest→mint. It is NOT mere bookkeeping — the mint
      // recipient is fixed at burn time and can't be redirected or re-burned
      // onto a new order, so this record is the ONLY thing that will ever get
      // the burn minted to Paycrest's receive address (via the stream here,
      // the daily cron, or the server-side backstop). Registering before the
      // confirmation poll is deliberate: a slow Soroban RPC that times out
      // the poll must not orphan a burn that actually landed — which is
      // exactly how a real user's ~10 USDC once got stuck, burned on Stellar
      // with nothing to mint it. registerBridgeTransfer retries + falls back
      // to sendBeacon; still awaited so the UI doesn't move on before the
      // first attempt has landed.
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

      // 5b) Now confirm the burn on-chain for the stepper. Non-fatal on
      // timeout: the transfer is registered, so the stream just opened (and
      // the cron) will carry it to mint, and the payout poll below is the
      // real completion signal. Only a definitive on-chain FAILED aborts.
      if (burnNeedsConfirm) {
        const outcome = await confirmSoroban(stellarTxHash);
        if (outcome === "failed") {
          throw new Error(
            "The burn transaction failed on-chain. No USDC left your wallet — please try again.",
          );
        }
        // "timeout" → keep going; the mint will complete in the background.
      }

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
      // A cancelled flow (or one the user has since restarted) must not
      // repaint the modal — its late signature rejection lands here too.
      if (offrampFlowRef.current !== myFlow) return;

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
      if (offrampFlowRef.current === myFlow) {
        setIsExecutingOfframp(false);
        setCurrentTxId(null);
      }
      // Don't close modal or reset step here — user dismisses modal manually
    }
  };

  /**
   * Offramp from an EVM source chain. Shares the Paycrest order + payout
   * polling machinery with the Stellar path, but the on-chain leg is
   * different: CCTP-bridge chains do approve(if needed) + depositForBurn and
   * feed the same attest/mint state machine; Base does a plain USDC
   * transfer() straight to Paycrest's receive address with no bridge at all.
   * Every signature is the user's own WalletConnect-connected wallet.
   */
  const handleExecuteEvmTrade = async (tradeData: {
    amount: string;
    rate: number;
    token: string;
    sourceChain: OfframpSourceChainKey;
    beneficiary: {
      institution: string;
      accountIdentifier: string;
      accountName: string;
      currency: string;
      memo?: string;
    };
  }) => {
    const chainKey = tradeData.sourceChain as EvmChainKey;
    const chainConfig = EVM_SOURCE_CHAINS[chainKey];
    if (!chainConfig) {
      setToastError(`Unsupported source chain: ${chainKey}`);
      return;
    }
    const connectedAddress = evmWallet.address;
    if (!connectedAddress) {
      setToastError("Connect your EVM wallet first.");
      return;
    }
    if (!pricingState.quote) {
      setToastError("Quote unavailable. Please enter an amount first.");
      return;
    }

    const baseReturnAddress = process.env.NEXT_PUBLIC_BASE_RETURN_ADDRESS;
    if (!baseReturnAddress) {
      throw new Error("NEXT_PUBLIC_BASE_RETURN_ADDRESS is missing");
    }

    const isBridge = isCctpBridgeChain(chainConfig);
    const txId = TransactionStorage.generateId();
    const myFlow = ++offrampFlowRef.current;
    setCurrentTxId(txId);
    setIsExecutingOfframp(true);
    setOfframpStep("initiating");
    setOfframpError(null);
    setShowProgressModal(true);

    const transaction: Transaction = {
      id: txId,
      timestamp: Date.now(),
      userAddress: connectedAddress,
      amount: tradeData.amount,
      currency: "NGN",
      beneficiary: tradeData.beneficiary,
      status: "pending",
    };
    TransactionStorage.save(transaction);
    setUserTransactions(TransactionStorage.getByUser(connectedAddress));

    try {
      setTradeState({ bridgeStatus: "building", payoutStatus: "pending" });

      // 1) Bridge quote → Paycrest order amount (identical to the Stellar path).
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
      const normalizedOrderAmount = Math.floor(paycrestOrderAmount * 1e6) / 1e6;
      const normalizedRate = Number(tradeData.rate.toFixed(6));

      // 2) Create the Paycrest order (identical to the Stellar path — the
      // payout side has no idea what chain the USDC came from).
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
            sourceChain: tradeData.sourceChain,
            senderAddress: connectedAddress,
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
      setUserTransactions(TransactionStorage.getByUser(connectedAddress));

      // 3) Make sure the wallet is on the right chain BEFORE asking for a
      // signature — the spec's explicit wrong-network handling.
      setOfframpStep("awaiting-signature");
      try {
        await evmWallet.switchChain(chainConfig.chainId);
      } catch {
        throw new Error(
          `Please switch your wallet to ${chainConfig.label} and try again.`,
        );
      }

      // 4) Build + sign the on-chain leg.
      let settlementTxHash: string;

      if (isBridge) {
        const buildEvmTx = async () => {
          const res = await fetch("/api/offramp/bridge/evm-build-tx", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              amount: tradeData.amount,
              fromAddress: connectedAddress,
              toAddress: settlementAddress,
              sourceChain: chainKey,
            }),
          });
          if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            throw new Error(
              payload?.error ||
                `Failed to build burn transaction: ${res.status}`,
            );
          }
          return res.json() as Promise<{
            calls: { to: `0x${string}`; data: `0x${string}` }[];
            chainId: number;
          }>;
        };

        let built = await buildEvmTx();
        if (built.calls.length > 1) {
          // Send the approve on its own, then wait until the server sees the
          // new allowance (i.e. the approve actually mined) before the burn —
          // firing both blind would revert the burn on a slow chain.
          await evmWallet.signAndSendCalls([built.calls[0]], built.chainId);
          setOfframpStep("submitting");
          const start = Date.now();
          while (Date.now() - start < 120_000) {
            await new Promise((r) => setTimeout(r, 4000));
            built = await buildEvmTx();
            if (built.calls.length === 1) break;
          }
          if (built.calls.length > 1) {
            throw new Error(
              "The approval didn't confirm in time. Please try again.",
            );
          }
          setOfframpStep("awaiting-signature");
        }

        const hashes = await evmWallet.signAndSendCalls(
          built.calls,
          built.chainId,
        );
        settlementTxHash = hashes[hashes.length - 1];
        setOfframpStep("submitting");

        setTradeState((prev) => ({
          ...prev,
          stellarTxHash: settlementTxHash,
          bridgeStatus: "pending",
        }));

        // Register the burn so the attest/mint state machine picks it up —
        // same permanent-strand risk as the Stellar path, so same retry +
        // sendBeacon fallback (registerEvmTransfer).
        await registerEvmTransfer("/api/offramp/bridge/register-transfer", {
          burnTxHash: settlementTxHash,
          mintRecipient: settlementAddress,
          amount: tradeData.amount,
          paycrestOrderId: payoutOrderId,
          sourceChain: chainKey,
          connectedAddress,
        });
        new EventSource(`/api/offramp/bridge/stream/${settlementTxHash}`);
      } else {
        // Base: plain USDC transfer() straight to Paycrest's receive address.
        const res = await fetch("/api/offramp/bridge/base-direct-tx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: tradeData.amount,
            toAddress: settlementAddress,
          }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(
            payload?.error || `Failed to build transfer: ${res.status}`,
          );
        }
        const { to, data, chainId } = await res.json();
        const hashes = await evmWallet.signAndSendCalls(
          [{ to, data }],
          chainId,
        );
        settlementTxHash = hashes[0];
        setOfframpStep("submitting");

        setTradeState((prev) => ({
          ...prev,
          stellarTxHash: settlementTxHash,
          bridgeStatus: "completed",
        }));

        await registerEvmTransfer("/api/offramp/bridge/base-direct-register", {
          txHash: settlementTxHash,
          connectedAddress,
          amountUsdc: tradeData.amount,
          destinationCurrency: tradeData.beneficiary.currency,
          destinationAmount: String(pricingState.quote.destinationAmount),
          paycrestOrderId: payoutOrderId,
        });
      }

      TransactionStorage.update(txId, {
        stellarTxHash: settlementTxHash, // reused field — EVM burn/transfer hash
        bridgeStatus: isBridge ? "pending" : "completed",
      });
      setUserTransactions(TransactionStorage.getByUser(connectedAddress));

      // 5) Poll payout (the critical path). For the CCTP path also poll bridge
      // status as best-effort background info.
      setOfframpStep("processing");
      if (isBridge) {
        pollBridgeStatus(txId, settlementTxHash)
          .then(() => {
            setOfframpStep((prev) =>
              prev === "processing" ? "settling" : prev,
            );
          })
          .catch(() => {
            // Bridge may still complete in the background — don't fail the flow.
          });
      }
      await pollPayoutStatus(txId, payoutOrderId);

      setOfframpStep("success");
      TransactionStorage.update(txId, { status: "completed" });
      setUserTransactions(TransactionStorage.getByUser(connectedAddress));

      fetch("/api/stats")
        .then((r) => r.json())
        .then(setPlatformStats)
        .catch(() => {});
      setFormResetKey((k) => k + 1);
    } catch (error: any) {
      if (offrampFlowRef.current !== myFlow) return;
      setTradeState((prev) => ({ ...prev, error: error.message }));
      setOfframpStep("error");
      setOfframpError(error.message);
      TransactionStorage.update(txId, {
        status: "failed",
        error: error.message,
      });
      setUserTransactions(TransactionStorage.getByUser(connectedAddress));
    } finally {
      if (offrampFlowRef.current === myFlow) {
        setIsExecutingOfframp(false);
        setCurrentTxId(null);
      }
    }
  };

  /**
   * Offramp from Solana. Always CCTP-bridge (Solana -> Base). Shares the
   * Paycrest order + polling machinery with the Stellar/EVM paths; the
   * on-chain leg is: client generates the ephemeral MessageSent event
   * keypair -> server builds an unsigned VersionedTransaction -> client
   * partial-signs with the keypair -> the wallet signs + sends.
   */
  const handleExecuteSolanaTrade = async (tradeData: {
    amount: string;
    rate: number;
    token: string;
    sourceChain: OfframpSourceChainKey;
    beneficiary: {
      institution: string;
      accountIdentifier: string;
      accountName: string;
      currency: string;
      memo?: string;
    };
  }) => {
    const connectedAddress = solanaWallet.address;
    if (!connectedAddress) {
      setToastError("Connect your Solana wallet first.");
      return;
    }
    if (!pricingState.quote) {
      setToastError("Quote unavailable. Please enter an amount first.");
      return;
    }
    const baseReturnAddress = process.env.NEXT_PUBLIC_BASE_RETURN_ADDRESS;
    if (!baseReturnAddress) {
      throw new Error("NEXT_PUBLIC_BASE_RETURN_ADDRESS is missing");
    }

    const txId = TransactionStorage.generateId();
    const myFlow = ++offrampFlowRef.current;
    setCurrentTxId(txId);
    setIsExecutingOfframp(true);
    setOfframpStep("initiating");
    setOfframpError(null);
    setShowProgressModal(true);

    const transaction: Transaction = {
      id: txId,
      timestamp: Date.now(),
      userAddress: connectedAddress,
      amount: tradeData.amount,
      currency: "NGN",
      beneficiary: tradeData.beneficiary,
      status: "pending",
    };
    TransactionStorage.save(transaction);
    setUserTransactions(TransactionStorage.getByUser(connectedAddress));

    try {
      setTradeState({ bridgeStatus: "building", payoutStatus: "pending" });

      // 1) Bridge quote → Paycrest order amount (identical to the other paths).
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
      const normalizedOrderAmount = Math.floor(paycrestOrderAmount * 1e6) / 1e6;
      const normalizedRate = Number(tradeData.rate.toFixed(6));

      // 2) Create the Paycrest order (identical to the other paths).
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
            sourceChain: tradeData.sourceChain,
            senderAddress: connectedAddress,
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
      setUserTransactions(TransactionStorage.getByUser(connectedAddress));

      // 3) Build the unsigned burn tx (client generates the event keypair).
      setOfframpStep("awaiting-signature");
      const eventKeypair = Keypair.generate();
      const buildRes = await fetch("/api/offramp/bridge/solana-build-tx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: tradeData.amount,
          ownerAddress: connectedAddress,
          toAddress: settlementAddress,
          eventAccountPubkey: eventKeypair.publicKey.toBase58(),
        }),
      });
      if (!buildRes.ok) {
        const payload = await buildRes.json().catch(() => ({}));
        throw new Error(
          payload?.error ||
            `Failed to build burn transaction: ${buildRes.status}`,
        );
      }
      const { transactionBase64 } = await buildRes.json();

      // 4) Partial-sign with the event keypair + wallet signs + sends.
      const burnSignature = await solanaWallet.signAndSendBurn(
        transactionBase64,
        eventKeypair,
      );
      console.log("[offramp] Solana burn signature:", burnSignature);
      setOfframpStep("submitting");
      setTradeState((prev) => ({
        ...prev,
        stellarTxHash: burnSignature,
        bridgeStatus: "pending",
      }));

      // 5) Register the burn (same permanent-strand risk + retry/sendBeacon).
      await registerEvmTransfer("/api/offramp/bridge/register-transfer", {
        burnTxHash: burnSignature,
        mintRecipient: settlementAddress,
        amount: tradeData.amount,
        paycrestOrderId: payoutOrderId,
        sourceChain: "solana",
        connectedAddress,
      });
      new EventSource(`/api/offramp/bridge/stream/${burnSignature}`);

      TransactionStorage.update(txId, {
        stellarTxHash: burnSignature, // reused field — Solana burn signature
        bridgeStatus: "pending",
      });
      setUserTransactions(TransactionStorage.getByUser(connectedAddress));

      // 6) Poll payout (critical) + bridge status (best-effort background).
      setOfframpStep("processing");
      pollBridgeStatus(txId, burnSignature)
        .then(() => {
          setOfframpStep((prev) => (prev === "processing" ? "settling" : prev));
        })
        .catch(() => {});
      await pollPayoutStatus(txId, payoutOrderId);

      setOfframpStep("success");
      TransactionStorage.update(txId, { status: "completed" });
      setUserTransactions(TransactionStorage.getByUser(connectedAddress));

      fetch("/api/stats")
        .then((r) => r.json())
        .then(setPlatformStats)
        .catch(() => {});
      setFormResetKey((k) => k + 1);
    } catch (error: any) {
      if (offrampFlowRef.current !== myFlow) return;
      setTradeState((prev) => ({ ...prev, error: error.message }));
      setOfframpStep("error");
      setOfframpError(error.message);
      TransactionStorage.update(txId, {
        status: "failed",
        error: error.message,
      });
      setUserTransactions(TransactionStorage.getByUser(connectedAddress));
    } finally {
      if (offrampFlowRef.current === myFlow) {
        setIsExecutingOfframp(false);
        setCurrentTxId(null);
      }
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
        if (activeUserAddress)
          setUserTransactions(TransactionStorage.getByUser(activeUserAddress));

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
        if (activeUserAddress)
          setUserTransactions(TransactionStorage.getByUser(activeUserAddress));

        // Advance the modal to "settling" once the deposit is validated or the
        // onchain release is underway.
        if (
          status === "validated" ||
          status === "fulfilled" ||
          status === "settling" ||
          status === "settled"
        ) {
          setOfframpStep((prev) =>
            prev === "processing" || prev === "settling" ? "settling" : prev,
          );
        }

        // Fiat has reached the recipient once the payout is validated —
        // Paycrest's own "payout confirmed by provider". `settled` is them
        // squaring up onchain with the provider ~16s later, which the user
        // isn't waiting on. `fulfilled` is the status where the bank is
        // actually credited; it emits no webhook today, but the API-poll
        // fallback can surface it, so accept it too.
        // Deliberately client-side: the webhook computes one status before the
        // onramp/offramp split, and the onramp bridge triggers on "settled".
        if (
          status === "validated" ||
          status === "fulfilled" ||
          status === "settled"
        )
          return "resolve";
        // Only these two mean real failure.
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
    return "Convert USDC to your bank account in minutes.";
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
            isConnected={
              headerUsesExternal ? externalWallet.isConnected : isConnected
            }
            isConnecting={
              headerUsesExternal ? externalWallet.isConnecting : isConnecting
            }
            walletAddress={
              headerUsesExternal ? externalWallet.address : wallet?.publicKey
            }
            // For a non-Stellar source the header shows that chain's USDC +
            // native gas token instead of the Stellar USDC + XLM reserve.
            stellarUsdcBalance={
              headerUsesExternal
                ? (externalBalances?.usdc ?? null)
                : stellarUsdcBalance
            }
            stellarXlmBalance={
              headerUsesExternal
                ? (externalBalances?.native ?? null)
                : stellarXlmBalance
            }
            nativeCurrencyLabel={
              headerUsesExternal
                ? (externalBalances?.nativeSymbol ??
                  (isSolanaSource ? "SOL" : "ETH"))
                : "XLM"
            }
            isBalanceLoading={
              headerUsesExternal
                ? externalWallet.isConnected && !externalBalances
                : isLoadingBalance
            }
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
                    isConnected={uiIsConnected}
                    isConnecting={uiIsConnecting}
                    isExecutingOfframp={isExecutingOfframp}
                    resetKey={formResetKey}
                    onConnect={handleConnect}
                    sourceChain={sourceChain}
                    onSourceChainChange={handleSourceChainChange}
                    walletAddress={activeUserAddress ?? null}
                    onInitiateOfframp={handleExecuteTrade}
                    onPricingUpdate={handlePricingUpdate}
                    usdcBalance={
                      sourceChain === "stellar"
                        ? stellarUsdcBalanceRaw
                        : externalBalances
                          ? Number(externalBalances.usdc)
                          : null
                    }
                    isLoadingBalance={
                      sourceChain === "stellar"
                        ? isLoadingBalance
                        : externalWallet.isConnected && !externalBalances
                    }
                  />
                </div>
                <div className="row-span-2 col-start-2 max-[1100px]:order-2 max-[1100px]:row-auto max-[1100px]:col-auto">
                  <RightPanel
                    stats={platformStats}
                    isConnected={uiIsConnected}
                    isConnecting={uiIsConnecting}
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
                isConnected={uiIsConnected}
                isConnecting={uiIsConnecting}
              />
            </>
          )}
        </div>
      </section>

      <ErrorToast message={toastError} onDismiss={() => setToastError(null)} />

      <EvmConnectModal
        open={evmWallet.isConnectModalOpen}
        injectedWallets={evmWallet.injectedWallets}
        pairingUri={evmWallet.pairingUri}
        isConnecting={evmWallet.isConnecting}
        error={evmWallet.error}
        onPickInjected={(rdns) => {
          void evmWallet.connectInjected(rdns).catch((e: any) => {
            setToastError(e?.message || "Failed to connect wallet");
          });
        }}
        onPickWalletConnect={() => {
          void evmWallet.connectWalletConnect().catch((e: any) => {
            setToastError(e?.message || "Failed to connect wallet");
          });
        }}
        onClose={evmWallet.closeConnect}
      />

      <SolanaConnectModal
        open={solanaConnectOpen}
        wallets={solanaWallet.detectedWallets}
        isConnecting={solanaWallet.isConnecting}
        error={solanaWallet.error}
        onPick={(name) => {
          void solanaWallet
            .connect(name)
            .then(() => setSolanaConnectOpen(false))
            .catch((e: any) =>
              setToastError(e?.message || "Failed to connect wallet"),
            );
        }}
        onClose={() => setSolanaConnectOpen(false)}
      />

      <TransactionProgressModal
        isOpen={showProgressModal}
        currentStep={offrampStep}
        error={offrampError}
        sourceChainLabel={activeSourceChainLabel}
        onCancel={() => {
          // Invalidate the in-flight flow so its (possibly much later)
          // signature rejection can't reopen or repaint this modal, then
          // reset as if it had never started.
          offrampFlowRef.current++;
          setShowProgressModal(false);
          setOfframpStep("idle");
          setOfframpError(null);
          setTradeState({});
          setIsExecutingOfframp(false);
          setCurrentTxId(null);
        }}
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
