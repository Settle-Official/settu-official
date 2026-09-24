"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect, useRef, useCallback } from "react";
import { AppSelect } from "@/components/app/AppSelect";
import { FlowModal } from "@/components/app/FlowModal";
import { CaretDownIcon, CheckIcon, CloseIcon } from "@/components/app/icons";
import { ResultCard } from "@/components/app/ResultCard";
import { fiatSymbol } from "@/lib/format/currency";
import { ONRAMP_STATUS_LABEL } from "@/lib/onramp/status-labels";
import { createOnrampOrder } from "@/lib/onramp/client";
import { TransactionStorage } from "@/lib/transaction-storage";
import type { OnrampProviderAccount } from "@/lib/offramp/types";

const PAYCREST_API_BASE = "https://api.paycrest.io/v1";

interface Bank {
  code: string;
  name: string;
}

interface Currency {
  code: string;
  name: string;
  symbol: string;
}

type OnrampPhase =
  | "form"
  | "awaiting-deposit"
  | "processing"
  | "done"
  | "error";

const isValidStellarAddress = (address: string) =>
  /^G[A-Z0-9]{55}$/.test(address);

export interface OnrampPanelProps {
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly walletAddress?: string;
  readonly onConnect: () => void;
  /** Fired once delivery is confirmed — a signal to refresh platform stats,
   * not a write trigger. The write itself happens server-side in
   * finalizeOnrampOrder, regardless of what detected the delivery. */
  readonly onDelivered?: () => void;
  /** Fired on every terminal status (delivered, refunded, or expired) — the
   * wallet's balance may have just changed (or the user needs to see that
   * it didn't), regardless of which way the order ended. */
  readonly onSettled?: () => void;
  /** Stellar USDC balance, for the readout under the amount field. */
  readonly usdcBalance?: number | null;
  readonly isLoadingBalance?: boolean;
}

/** Matches the offramp form's floor so the two screens agree. */
const MIN_USDC = 0.7;

// The provider's status sequence, as steps. `settling` and `settled` are one
// step to the user — both mean "the USDC is being released" — and `pending`
// sits before the list entirely, which is the deposit screen's own job to
// narrate rather than this one's.
const ONRAMP_STEPS = [
  { keys: ["deposited"], label: "Payment received" },
  { keys: ["validated"], label: "Confirmed by provider" },
  { keys: ["settling", "settled"], label: "Releasing your USDC" },
  { keys: ["bridging"], label: "Bridging to your Stellar wallet" },
  { keys: ["delivered"], label: "Delivered to your wallet" },
] as const;

const onrampStepIndex = (status: string) =>
  ONRAMP_STEPS.findIndex((s) => (s.keys as readonly string[]).includes(status));

// The design's own class vocabulary, shared with FormCard.
const SECTION_HEADING =
  "font-[family-name:var(--font-inter)] text-[22px] leading-[27px] text-white max-[720px]:text-[16px] max-[720px]:leading-[20px]";
const FIELD_LABEL =
  "font-[family-name:var(--font-sora)] text-[20px] leading-[25px] text-[#bdbcbc] max-[720px]:text-[15px] max-[720px]:leading-[19px]";
const FIELD_BOX =
  "flex h-[70px] w-full items-center gap-[10px] rounded-[20px] border px-[20px] font-[family-name:var(--font-sora)] text-[20px] leading-[25px] text-white transition-colors max-[720px]:h-[54px] max-[720px]:rounded-[14px] max-[720px]:px-[16px] max-[720px]:text-[16px] max-[720px]:leading-[20px]";

// User-facing copy for each streamed onramp status.
export function OnrampPanel({
  isConnected,
  isConnecting,
  walletAddress,
  onConnect,
  onDelivered,
  onSettled,
  usdcBalance = null,
  isLoadingBalance = false,
}: Readonly<OnrampPanelProps>) {
  const router = useRouter();
  const [phase, setPhase] = useState<OnrampPhase>("form");

  // Form state
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("NGN");
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [isLoadingCurrencies, setIsLoadingCurrencies] = useState(false);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [isLoadingBanks, setIsLoadingBanks] = useState(false);
  const [bank, setBank] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountName, setAccountName] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [useCustomAddress, setUseCustomAddress] = useState(false);
  const [customAddress, setCustomAddress] = useState("");
  // The design lets the amount be entered either way round. The API only
  // takes fiat, so a USDC entry is converted with the live rate before it is
  // submitted, and the fiat figure shown is the one that gets sent.
  const [amountMode, setAmountMode] = useState<"fiat" | "crypto">("fiat");
  const [rate, setRate] = useState<number | null>(null);
  const [isLoadingRate, setIsLoadingRate] = useState(false);
  const [showFee, setShowFee] = useState(false);
  /** USDC the order actually bought, resolved from the provider's own rate. */
  const [deliveredUsdc, setDeliveredUsdc] = useState<string | null>(null);

  // Order state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [providerAccount, setProviderAccount] =
    useState<OnrampProviderAccount | null>(null);
  const [status, setStatus] = useState<string>("pending");
  const [checkState, setCheckState] = useState<"idle" | "checking" | "waiting">(
    "idle",
  );
  const lastCheckRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  // Load currencies
  useEffect(() => {
    (async () => {
      setIsLoadingCurrencies(true);
      try {
        const res = await fetch(`${PAYCREST_API_BASE}/currencies`);
        const data = await res.json();
        const list: Currency[] = Array.isArray(data?.data) ? data.data : [];
        setCurrencies(list);
        if (list.some((c) => c.code === "NGN")) setCurrency("NGN");
        else if (list[0]?.code) setCurrency(list[0].code);
      } catch {
        /* non-fatal */
      } finally {
        setIsLoadingCurrencies(false);
      }
    })();
  }, []);

  // Load banks for currency (used for the refund account)
  useEffect(() => {
    if (!currency) return;
    (async () => {
      setIsLoadingBanks(true);
      try {
        const res = await fetch(
          `${PAYCREST_API_BASE}/institutions/${encodeURIComponent(currency)}`,
        );
        const data = await res.json();
        setBanks(Array.isArray(data?.data) ? data.data : []);
      } catch {
        setBanks([]);
      } finally {
        setIsLoadingBanks(false);
      }
    })();
  }, [currency]);

  // Live market rate for the amount preview. Paycrest's public rates
  // endpoint, same host this panel already uses for currencies and banks.
  // Indicative only: the order's own rate is what is finally charged, and
  // the deposit screen shows that exact figure.
  useEffect(() => {
    if (!currency) return;
    const debounce = setTimeout(() => {
      setIsLoadingRate(true);
      (async () => {
        try {
          const res = await fetch(
            `${PAYCREST_API_BASE}/rates/USDC/1/${encodeURIComponent(currency)}`,
          );
          const data = await res.json();
          const value = Number(data?.data);
          setRate(Number.isFinite(value) && value > 0 ? value : null);
        } catch {
          setRate(null);
        } finally {
          setIsLoadingRate(false);
        }
      })();
    }, 250);
    return () => clearTimeout(debounce);
  }, [currency]);

  // Verify refund account name
  useEffect(() => {
    if (accountNumber.length === 10 && bank) {
      setIsVerifying(true);
      (async () => {
        try {
          const res = await fetch(`${PAYCREST_API_BASE}/verify-account`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              institution: bank,
              accountIdentifier: accountNumber,
            }),
          });
          const data = await res.json();
          const name =
            data?.data?.accountName || data?.data || data?.accountName || "";
          setAccountName(typeof name === "string" ? name : "");
        } catch {
          setAccountName("");
        } finally {
          setIsVerifying(false);
        }
      })();
    } else {
      setAccountName("");
    }
  }, [accountNumber, bank]);

  // Applies a status from either transport. Returns true once terminal;
  // bridge_failed is held for manual resolution, so it stays subscribed.
  const applyStatus = useCallback(
    (next: string): boolean => {
      setStatus(next);
      if (next === "settled" || next === "bridging") {
        setPhase("processing");
        return false;
      }
      if (next === "delivered") {
        setPhase("done");
        if (orderId) TransactionStorage.updateByOrderId(orderId, { status: "completed" });
        onDelivered?.();
        onSettled?.();
        return true;
      }
      if (next === "refunded" || next === "expired") {
        setPhase("error");
        if (orderId) TransactionStorage.updateByOrderId(orderId, { status: "failed", error: next });
        onSettled?.();
        return true;
      }
      if (next === "bridge_failed") setPhase("error");
      return false;
    },
    [onDelivered, onSettled, orderId],
  );

  // Authoritative read, shared by the backstop poller and the manual check.
  // It only asks the server what it already knows — it never claims payment.
  const fetchStatus = useCallback(async (): Promise<boolean> => {
    if (!orderId) return false;
    const res = await fetch(`/api/onramp/order/${orderId}`);
    if (!res.ok) return false;
    const next = (await res.json())?.data?.status;
    return next ? applyStatus(next) : false;
  }, [orderId, applyStatus]);

  // Manual re-check, debounced so impatient taps can't hammer the API.
  const checkNow = useCallback(async () => {
    const now = Date.now();
    if (now - lastCheckRef.current < 5000) return;
    lastCheckRef.current = now;
    setCheckState("checking");
    const terminal = await fetchStatus().catch(() => false);
    // "Not yet" is the normal answer here, not an error worth shouting about.
    setCheckState(terminal ? "idle" : "waiting");
  }, [fetchStatus]);

  // The stream alone isn't enough here: paying the bank means leaving the
  // browser, and a backgrounded tab can lose the connection with no event we
  // can see. Reconnect, poll, and re-check whenever the tab comes back.
  useEffect(() => {
    if (!orderId) return;
    let done = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (done) return;
      const es = new EventSource(`/api/onramp/stream/${orderId}`);
      esRef.current = es;
      es.onmessage = (evt) => {
        try {
          const rec = JSON.parse(evt.data) as { status?: string };
          if (rec.status && applyStatus(rec.status)) {
            done = true;
            es.close();
          }
        } catch {
          /* ignore malformed frame */
        }
      };
      // A closed stream is routine (the route caps at 60s), not a failure.
      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED) return;
        es.close();
        esRef.current = null;
        if (!done) reconnectTimer = setTimeout(connect, 3000);
      };
    };

    const check = () => {
      if (done) return;
      fetchStatus()
        .then((terminal) => {
          if (terminal) {
            done = true;
            esRef.current?.close();
          }
        })
        .catch(() => {});
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };

    connect();
    const pollTimer = setInterval(check, 12000);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      done = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisible);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [orderId, applyStatus, fetchStatus]);

  const destinationAddress = useCustomAddress
    ? customAddress.trim()
    : walletAddress;

  // Whichever side was typed, resolve both. `fiatAmount` is what gets sent.
  const typed = Number.parseFloat(amount);
  const hasAmount = Number.isFinite(typed) && typed > 0;
  const usdcAmount =
    !hasAmount ? null : amountMode === "crypto" ? typed : rate ? typed / rate : null;
  const fiatAmount =
    !hasAmount ? null : amountMode === "fiat" ? typed : rate ? typed * rate : null;
  const meetsMinimum = usdcAmount !== null && usdcAmount >= MIN_USDC;

  const canSubmit =
    isConnected &&
    !isSubmitting &&
    hasAmount &&
    fiatAmount !== null &&
    meetsMinimum &&
    !!currency &&
    !!bank &&
    accountNumber.length === 10 &&
    !!accountName &&
    !!destinationAddress &&
    (!useCustomAddress || isValidStellarAddress(customAddress.trim()));

  const handleSubmit = async () => {
    if (!isConnected) {
      onConnect();
      return;
    }
    if (!canSubmit || !destinationAddress || fiatAmount === null) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const result = await createOnrampOrder({
        // Always the resolved fiat, never the raw input — in USDC mode
        // `amount` is USDC and would otherwise be read as naira.
        fiatAmount: fiatAmount.toFixed(2),
        // Fallback for the recorded USDC amount when the provider quotes no
        // rate back; the order's own rate is preferred when it does.
        estimatedUsdc: usdcAmount?.toFixed(2),
        currency,
        userStellarAddress: destinationAddress,
        refundAccount: {
          institution: bank,
          accountIdentifier: accountNumber,
          accountName,
        },
      });
      setOrderId(result.id);
      // The provider's own figures, not the indicative rate above — this is
      // what the success card reports back. Same precedence the stored
      // history row uses, so the two can't disagree.
      const providerUsdc = Number(result.usdcAmount);
      const orderRate = Number(result.rate);
      setDeliveredUsdc(
        Number.isFinite(providerUsdc) && providerUsdc > 0
          ? providerUsdc.toFixed(2)
          : Number.isFinite(orderRate) && orderRate > 0
            ? (fiatAmount / orderRate).toFixed(2)
            : (usdcAmount?.toFixed(2) ?? null),
      );
      setProviderAccount(result.providerAccount);
      setStatus(result.status || "pending");
      setPhase("awaiting-deposit");
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
      setPhase("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const reset = () => {
    esRef.current?.close();
    setPhase("form");
    setOrderId(null);
    setProviderAccount(null);
    setStatus("pending");
    setError(null);
    setAmount("");
    setAccountNumber("");
    setBank("");
    setAccountName("");
    setUseCustomAddress(false);
    setCustomAddress("");
    setDeliveredUsdc(null);
    setShowFee(false);
  };

  // --- Render ---------------------------------------------------------------

  const symbol = fiatSymbol(currency);
  // Both decimals or none — a USDC-side entry converts to something like
  // 34155.5, and "₦34,155.5" reads as a typo rather than a price.
  const fmtFiat = (n: number) =>
    `${symbol}${n.toLocaleString("en-US", {
      minimumFractionDigits: n % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    })}`;

  if (phase === "awaiting-deposit" && providerAccount) {
    return (
      <VirtualAccountView
        account={providerAccount}
        status={status}
        onCancel={reset}
        onCheckNow={checkNow}
        checkState={checkState}
      />
    );
  }

  if (phase === "done") {
    const short = destinationAddress
      ? `${destinationAddress.slice(0, 6)}…${destinationAddress.slice(-6)}`
      : "your wallet";
    return (
      <ResultCard
        kind="success"
        // The amount is the USDC bought, not the fiat paid — the fiat has
        // already left the user's bank by this point, and what they are
        // waiting on is the crypto.
        title={`Done! ${deliveredUsdc ?? ""} USDC is on its way`.replace("  ", " ")}
        body={`Sent to ${short}. It usually lands within minutes.`}
        actionLabel="View Transaction"
        onAction={() => router.push("/app/history")}
      />
    );
  }

  if (phase === "error") {
    return (
      <ResultCard
        kind="failed"
        title="Oops! Transaction failed"
        body={error ?? ONRAMP_STATUS_LABEL[status] ?? ONRAMP_STATUS_LABEL.unknown}
        actionLabel="Try again"
        onAction={reset}
      />
    );
  }

  if (phase === "processing") {
    // Same treatment as the offramp: the screen the user was just on stays
    // put behind a blurred scrim, with the progress card over it — rather
    // than the deposit details they may still want to check vanishing the
    // moment the transfer lands. Not dismissable: the transfer is in flight.
    return (
      <>
        {providerAccount && (
          <VirtualAccountView
            account={providerAccount}
            status={status}
            onCancel={reset}
            onCheckNow={checkNow}
            checkState={checkState}
          />
        )}
        <FlowModal dismissable={false} onDismiss={() => {}}>
          <OnrampProgressCard status={status} />
        </FlowModal>
      </>
    );
  }

  const buttonLabel = !isConnected
    ? "Connect Wallet"
    : isSubmitting
      ? "Creating order…"
      : "Continue";

  return (
    <div className="flex flex-col gap-[30px] max-[720px]:gap-[24px]">
      <section className="flex flex-col gap-[30px] max-[720px]:gap-[22px]">
        <h2 className={SECTION_HEADING}>Onramp information</h2>

        <div className="flex flex-col gap-[10px] border-b-[0.4px] border-[#6a6969] pb-[20px] max-[720px]:pb-[16px]">
          <div className="flex flex-col gap-[14px] max-[720px]:gap-[10px]">
            <span className={FIELD_LABEL}>Amount to buy</span>
            <div className={`${FIELD_BOX} border-[#d7d6d6]/70 focus-within:border-[#d7d6d6]`}>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                // A focused number input still eats scroll-wheel ticks to
                // bump its value — blurring hands that scroll back to the page.
                onWheel={(e) => e.currentTarget.blur()}
                min={0}
                step={amountMode === "fiat" ? "1" : "0.000001"}
                placeholder="0.00"
                aria-label={amountMode === "fiat" ? `Amount in ${currency}` : "Amount in USDC"}
                className="min-w-0 flex-1 bg-transparent font-[family-name:var(--font-inter)] text-[20px] leading-[24px] text-white outline-none placeholder:text-[#8d8c8c] max-[720px]:text-[16px] max-[720px]:leading-[20px] [appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none"
              />
              {/* Enter either side of the pair; switching carries the value
                  across at the live rate so nothing has to be retyped. */}
              <div className="flex shrink-0 items-center gap-[4px] rounded-full bg-white/5 p-[3px]">
                {(["fiat", "crypto"] as const).map((mode) => {
                  const isActive = mode === amountMode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => {
                        if (isActive) return;
                        const carried = mode === "fiat" ? fiatAmount : usdcAmount;
                        if (carried !== null) {
                          setAmount(mode === "fiat" ? carried.toFixed(2) : carried.toFixed(6));
                        }
                        setAmountMode(mode);
                      }}
                      style={{
                        backgroundColor: isActive ? "rgba(201,169,98,0.35)" : "transparent",
                      }}
                      className={`rounded-full px-[12px] py-[5px] font-[family-name:var(--font-inter)] text-[14px] leading-[17px] transition-colors max-[720px]:px-[9px] max-[720px]:py-[4px] max-[720px]:text-[12px] max-[720px]:leading-[15px] ${
                        isActive ? "text-white" : "text-[#bdbcbc]"
                      }`}
                    >
                      {mode === "fiat" ? currency : "USDC"}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-[10px] font-[family-name:var(--font-inter)] text-[16px] leading-[19px] text-white max-[720px]:gap-[8px] max-[720px]:text-[13px] max-[720px]:leading-[16px]">
            <span>Min {MIN_USDC} USDC</span>
            <span className="size-[6px] rounded-full bg-[#c4c4c4]" aria-hidden="true" />
            <span>
              {isLoadingBalance
                ? "Balance: checking…"
                : usdcBalance !== null
                  ? `Balance: ${usdcBalance.toFixed(2)} USDC`
                  : "Balance: —"}
            </span>
            {hasAmount && !meetsMinimum && (
              <>
                <span className="size-[6px] rounded-full bg-[#c4c4c4]" aria-hidden="true" />
                <span className="text-[#e07a7e]">Below the {MIN_USDC} USDC minimum</span>
              </>
            )}
          </div>
        </div>

        <div className="rounded-[20px] bg-[#2b2a2a] max-[720px]:rounded-[14px]">
          <div className="flex items-center justify-between gap-[20px] px-[30px] py-[20px] font-[family-name:var(--font-inter)] text-[16px] leading-[19px] text-white max-[720px]:gap-[10px] max-[720px]:px-[16px] max-[720px]:py-[16px]">
            <span className="min-w-0 truncate text-[20px] font-semibold leading-[26px] text-[#c9a962] max-[720px]:text-[14px] max-[720px]:leading-[18px]">
              {usdcAmount !== null
                ? `You'll receive ${usdcAmount.toFixed(2)} USDC.`
                : hasAmount && isLoadingRate
                  ? "Getting your rate…"
                  : "You'll receive —"}
            </span>
            <button
              type="button"
              onClick={() => setShowFee((f) => !f)}
              aria-expanded={showFee}
              className="flex shrink-0 items-center gap-[10px] p-[10px] text-white max-[720px]:gap-[6px] max-[720px]:p-0 max-[720px]:text-[12px] max-[720px]:leading-[15px]"
            >
              {showFee ? "Hide fee" : "Show fee"}
              <CaretDownIcon
                size={18}
                className={`text-[#f4f2f2] transition-transform ${showFee ? "rotate-180" : ""}`}
              />
            </button>
          </div>
          {/* Always mounted — .fee-reveal in globals.css animates it. */}
          <div className={`fee-reveal ${showFee ? "is-open" : ""}`}>
            <div>
              <dl className="grid grid-cols-[1fr_auto] gap-x-[20px] gap-y-[12px] border-t border-white/10 px-[30px] py-[20px] font-[family-name:var(--font-inter)] text-[15px] leading-[19px] text-[#dcd6d6] max-[720px]:gap-x-[12px] max-[720px]:gap-y-[10px] max-[720px]:px-[16px] max-[720px]:py-[16px] max-[720px]:text-[12px] max-[720px]:leading-[16px]">
                <div className="contents">
                  <dt>You&rsquo;ll pay</dt>
                  <dd className="text-right text-white">
                    {fiatAmount !== null ? fmtFiat(fiatAmount) : "—"}
                  </dd>
                </div>
                <div className="contents">
                  <dt>Rate</dt>
                  <dd className="text-right text-white">
                    {rate ? `1 USDC = ${symbol}${rate.toLocaleString("en-US")}` : "—"}
                  </dd>
                </div>
                <div className="contents">
                  <dt>Delivered to</dt>
                  <dd className="min-w-0 break-all text-right text-white">
                    {destinationAddress
                      ? `${destinationAddress.slice(0, 6)}…${destinationAddress.slice(-6)}`
                      : "—"}
                  </dd>
                </div>
                <div className="contents">
                  <dt>Quote</dt>
                  <dd className="text-right text-white">Indicative until the order is created</dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-[30px] max-[720px]:gap-[22px]">
        <h2 className={SECTION_HEADING}>Refund Bank</h2>
        <div className="grid grid-cols-2 gap-x-[106px] gap-y-[30px] max-[1100px]:grid-cols-1 max-[1100px]:gap-x-[20px] max-[720px]:gap-y-[22px]">
          <div className="flex flex-col gap-[14px] max-[720px]:gap-[10px]">
            <span className={FIELD_LABEL}>Account number</span>
            <div className={`${FIELD_BOX} border-[#d7d6d6]/70 focus-within:border-[#d7d6d6]`}>
              <input
                type="text"
                inputMode="numeric"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                maxLength={10}
                placeholder="0123456789"
                aria-label="Refund account number"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[#8d8c8c]"
              />
            </div>
          </div>
          <div className="flex flex-col gap-[14px] max-[720px]:gap-[10px]">
            <span className={FIELD_LABEL}>Bank</span>
            <AppSelect
              aria-label="Refund bank"
              value={bank}
              onChange={setBank}
              options={banks}
              isLoading={isLoadingBanks}
              placeholder="Select"
            />
          </div>
        </div>
        <div className="flex flex-col gap-[14px] max-[720px]:gap-[10px]">
          <span className={FIELD_LABEL}>Account name</span>
          <div
            className={`${FIELD_BOX} border-[#d7d6d6]/70 ${accountName ? "text-white" : "text-[#8d8c8c]"}`}
            aria-live="polite"
          >
            {isVerifying ? "Verifying…" : accountName || "-"}
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-[20px] max-[720px]:gap-[16px]">
        <p className="rounded-[20px] bg-[#2b2a2a] px-[30px] py-[16px] text-center font-[family-name:var(--font-sora)] text-[14px] leading-[22px] text-[#bdbcbc] max-[720px]:rounded-[14px] max-[720px]:px-[16px] max-[720px]:text-left max-[720px]:text-[12px] max-[720px]:leading-[18px]">
          By default, USDC is sent to your connected wallet address. Tick the box below to
          send it to a different Stellar address instead.
        </p>
        <label className="flex cursor-pointer items-center gap-[12px] font-[family-name:var(--font-sora)] text-[16px] leading-[20px] text-[#e6e3e3] max-[720px]:gap-[10px] max-[720px]:text-[14px]">
          <input
            type="checkbox"
            checked={useCustomAddress}
            onChange={(e) => setUseCustomAddress(e.target.checked)}
            className="peer sr-only"
          />
          {/* Driven off React state rather than `peer-checked:`, which only
              reaches siblings of the input — the tick is a descendant. */}
          <span
            aria-hidden="true"
            style={{ backgroundColor: useCustomAddress ? "#ecc56f" : "transparent" }}
            className="flex size-[22px] shrink-0 items-center justify-center rounded-[6px] border border-[#ecc56f] text-[#111010] transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[#ecc56f]/50 max-[720px]:size-[20px]"
          >
            {useCustomAddress && <CheckIcon size={14} strokeWidth={3} />}
          </span>
          Send to a different Stellar address
        </label>
        {useCustomAddress && (
          <div className="flex flex-col gap-[14px] max-[720px]:gap-[10px]">
            <span className={FIELD_LABEL}>Destination Stellar Address</span>
            <div
              className={`${FIELD_BOX} ${
                customAddress.trim() && !isValidStellarAddress(customAddress.trim())
                  ? "border-[#ac4747]"
                  : "border-[#d7d6d6]/70 focus-within:border-[#d7d6d6]"
              }`}
            >
              <input
                type="text"
                value={customAddress}
                onChange={(e) => setCustomAddress(e.target.value)}
                placeholder="G....."
                aria-label="Destination Stellar address"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[#8d8c8c]"
              />
            </div>
            {customAddress.trim() && !isValidStellarAddress(customAddress.trim()) && (
              <span className="font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-[#ac4747]">
                Enter a valid Stellar address (starts with G, 56 characters).
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="font-[family-name:var(--font-sora)] text-[15px] leading-[22px] text-[#e07a7e]">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={isConnected ? !canSubmit : isConnecting}
        // Inline: globals.css's unlayered `button { background: none }` reset
        // beats layered bg-* utilities.
        style={{ backgroundColor: "#ecc56f" }}
        className="flex h-[80px] w-full items-center justify-center gap-[12px] rounded-[40px] font-[family-name:var(--font-sora)] text-[20px] font-semibold leading-[25px] text-[#111010] transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70 max-[720px]:mt-[6px] max-[720px]:h-[60px] max-[720px]:text-[17px] max-[720px]:leading-[21px]"
      >
        {buttonLabel}
        {isSubmitting && (
          <span
            className="landing-offramp-spin inline-block size-[22px] rounded-full border-2 border-dashed border-[#111010]"
            aria-hidden="true"
          />
        )}
      </button>
    </div>
  );
}


function VirtualAccountView({
  account,
  status,
  onCancel,
  onCheckNow,
  checkState,
}: {
  account: OnrampProviderAccount;
  status: string;
  onCancel: () => void;
  onCheckNow: () => void;
  checkState: "idle" | "checking" | "waiting";
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, value: string) => {
    navigator.clipboard?.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="flex flex-col gap-[30px] max-[720px]:gap-[22px]">
      <div className="flex flex-col gap-[10px]">
        <h2 className="font-[family-name:var(--font-inter)] text-[22px] uppercase leading-[27px] text-white max-[720px]:text-[17px] max-[720px]:leading-[22px]">
          Send {account.currency} {account.amountToTransfer}
        </h2>
        <p className="font-[family-name:var(--font-sora)] text-[16px] leading-[24px] text-[#a19d9d] max-[720px]:text-[13px] max-[720px]:leading-[19px]">
          Transfer the exact amount to the account below. USDC is delivered to your Stellar
          wallet once received.
        </p>
      </div>

      <div className="flex flex-col gap-[16px] max-[720px]:gap-[10px]">
        <CopyRow
          label="Bank Name"
          value={account.institution}
          copied={copied === "Bank Name"}
          onCopy={() => copy("Bank Name", account.institution)}
        />
        <CopyRow
          label="Account Number"
          value={account.accountIdentifier}
          copied={copied === "Account Number"}
          onCopy={() => copy("Account Number", account.accountIdentifier)}
        />
        <CopyRow
          label="Account Name"
          value={account.accountName}
          copied={copied === "Account Name"}
          onCopy={() => copy("Account Name", account.accountName)}
        />
        <CopyRow
          label="Exact Amount"
          value={account.amountToTransfer}
          copied={copied === "Exact Amount"}
          onCopy={() => copy("Exact Amount", account.amountToTransfer)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-[24px] max-[720px]:flex-col max-[720px]:items-start max-[720px]:gap-[14px]">
        <Countdown validUntil={account.validUntil} />
        <span className="flex items-center gap-[10px] font-[family-name:var(--font-sora)] text-[16px] leading-[20px] text-[#bdbcbc] max-[720px]:text-[13px]">
          <Spinner />
          {ONRAMP_STATUS_LABEL[status] ?? ONRAMP_STATUS_LABEL.pending}
        </span>
      </div>

      {checkState === "waiting" && (
        <p className="font-[family-name:var(--font-sora)] text-[14px] leading-[20px] text-[#8d8c8c] max-[720px]:text-[12px]">
          Not showing yet — bank transfers can take a few minutes. This updates
          automatically, so you can leave this page open.
        </p>
      )}

      <div className="flex gap-[20px] max-[720px]:flex-col-reverse max-[720px]:gap-[12px]">
        {/* Inline border/background: globals.css's unlayered
            `button { background: none; border: 0 }` reset beats the layered
            utilities. */}
        <button
          type="button"
          onClick={onCancel}
          style={{ border: "1px solid rgba(224,122,126,0.6)" }}
          className="flex h-[70px] w-[230px] shrink-0 items-center justify-center gap-[10px] rounded-[40px] font-[family-name:var(--font-sora)] text-[18px] text-[#e07a7e] transition-[filter] hover:brightness-125 max-[720px]:h-[56px] max-[720px]:w-full max-[720px]:text-[15px]"
        >
          Cancel
          <CloseIcon size={16} />
        </button>
        <button
          type="button"
          onClick={onCheckNow}
          disabled={checkState === "checking"}
          style={{ backgroundColor: "#ecc56f" }}
          className="flex h-[70px] min-w-0 flex-1 items-center justify-center rounded-[40px] px-[16px] font-[family-name:var(--font-sora)] text-[18px] font-semibold text-[#111010] transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70 max-[720px]:h-[56px] max-[720px]:w-full max-[720px]:text-[15px]"
        >
          {checkState === "checking" ? "Checking…" : "I've sent it - Check Now"}
        </button>
      </div>
    </div>
  );
}

/**
 * The in-flight card, shown over a blurred deposit screen — the onramp's
 * counterpart to the offramp's "Processing Offramp" stepper.
 */
function OnrampProgressCard({ status }: { readonly status: string }) {
  const activeIndex = onrampStepIndex(status);
  return (
    <div className="flex w-[398px] max-w-full flex-col gap-[28px] rounded-[20px] bg-[#232222] px-[24px] py-[28px] max-[720px]:gap-[22px] max-[720px]:rounded-[14px] max-[720px]:px-[20px] max-[720px]:py-[24px]">
      <div className="flex flex-col gap-[6px]">
        <h2 className="font-[family-name:var(--font-sora)] text-[18px] leading-[23px] text-white max-[720px]:text-[16px] max-[720px]:leading-[20px]">
          Processing Onramp
        </h2>
        <p className="font-[family-name:var(--font-sora)] text-[14px] leading-[20px] text-[#8d8c8c] max-[720px]:text-[13px]">
          {ONRAMP_STATUS_LABEL[status] ?? ONRAMP_STATUS_LABEL.unknown}
        </p>
      </div>
      <ol className="flex flex-col">
        {ONRAMP_STEPS.map((step, i) => {
          const done = activeIndex > i;
          const current = activeIndex === i;
          const last = i === ONRAMP_STEPS.length - 1;
          return (
            <li key={step.label} className="flex gap-[14px]">
              <div className="flex flex-col items-center">
                <span
                  className={`flex size-[24px] shrink-0 items-center justify-center rounded-full border ${
                    done
                      ? "border-[#c9a962] bg-[#c9a962] text-[#1a1a1a]"
                      : current
                        ? "landing-offramp-spin border-dashed border-white"
                        : "border-[#6a6969]"
                  }`}
                >
                  {done && <CheckIcon size={13} strokeWidth={2.6} />}
                </span>
                {!last && <span className="my-[4px] w-px flex-1 bg-[#4d4c4c]" />}
              </div>
              <span
                className={`pb-[26px] font-[family-name:var(--font-sora)] text-[15px] leading-[24px] max-[720px]:pb-[22px] max-[720px]:text-[14px] ${
                  done ? "text-[#c9a962]" : current ? "text-white" : "text-[#8d8c8c]"
                }`}
              >
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Countdown({ validUntil }: { validUntil: string }) {
  const [remaining, setRemaining] = useState<number>(() =>
    Math.max(0, new Date(validUntil).getTime() - Date.now()),
  );
  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, new Date(validUntil).getTime() - Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [validUntil]);

  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  return (
    <span className="flex h-[56px] items-center gap-[10px] rounded-[20px] bg-[#2b2a2a] px-[24px] font-[family-name:var(--font-sora)] text-[16px] leading-[20px] text-[#bdbcbc] max-[720px]:h-[44px] max-[720px]:rounded-[14px] max-[720px]:px-[14px] max-[720px]:text-[13px]">
      {remaining > 0 ? (
        <>
          Expire in
          <span className="text-[#c9a962]">
            {mins} : {secs.toString().padStart(2, "0")}
          </span>
        </>
      ) : (
        <span className="text-[#e07a7e]">Order window expired</span>
      )}
    </span>
  );
}

function CopyRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div
      style={{ border: "1px solid rgba(215,214,214,0.35)" }}
      className="flex items-center justify-between gap-[16px] rounded-[20px] px-[24px] py-[16px] max-[720px]:gap-[10px] max-[720px]:rounded-[14px] max-[720px]:px-[16px] max-[720px]:py-[12px]"
    >
      <span className="flex min-w-0 flex-col gap-[4px]">
        <span className="font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-[#a19d9d] max-[720px]:text-[12px] max-[720px]:leading-[15px]">
          {label}
        </span>
        <span className="truncate font-[family-name:var(--font-sora)] text-[20px] leading-[26px] text-white max-[720px]:text-[15px] max-[720px]:leading-[20px]">
          {value}
        </span>
      </span>
      <button
        type="button"
        onClick={onCopy}
        aria-label={`Copy ${label}`}
        style={{ backgroundColor: "#ecc56f" }}
        className="flex h-[42px] shrink-0 items-center gap-[6px] rounded-[10px] px-[14px] font-[family-name:var(--font-sora)] text-[14px] font-medium text-[#111010] transition-[filter] hover:brightness-105 max-[720px]:h-[34px] max-[720px]:px-[10px] max-[720px]:text-[12px]"
      >
        {copied ? "Copied" : "Copy"}
        <CopyIcon size={14} />
      </button>
    </div>
  );
}

function CopyIcon({ size = 14 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="12" height="12" rx="2.5" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  );
}

function Spinner({ large }: { readonly large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`landing-offramp-spin inline-block shrink-0 rounded-full border-2 border-dashed border-[#c9a962] ${
        large ? "size-[34px]" : "size-[16px]"
      }`}
    />
  );
}
