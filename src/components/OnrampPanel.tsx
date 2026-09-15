"use client";

import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { SelectField } from "@/components/SelectField";
import { ONRAMP_STATUS_LABEL } from "@/lib/onramp/status-labels";

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

interface ProviderAccount {
  institution: string;
  accountIdentifier: string;
  accountName: string;
  amountToTransfer: string;
  currency: string;
  validUntil: string;
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
}

// User-facing copy for each streamed onramp status.
export function OnrampPanel({
  isConnected,
  isConnecting,
  walletAddress,
  onConnect,
  onDelivered,
}: Readonly<OnrampPanelProps>) {
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

  // Order state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [providerAccount, setProviderAccount] =
    useState<ProviderAccount | null>(null);
  const [status, setStatus] = useState<string>("pending");
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

  // Subscribe to status stream once an order exists.
  useEffect(() => {
    if (!orderId) return;
    const es = new EventSource(`/api/onramp/stream/${orderId}`);
    esRef.current = es;
    es.onmessage = (evt) => {
      try {
        const rec = JSON.parse(evt.data) as { status?: string };
        if (!rec.status) return;
        setStatus(rec.status);
        if (rec.status === "settled" || rec.status === "bridging") {
          setPhase("processing");
        } else if (rec.status === "delivered") {
          setPhase("done");
          es.close();
          onDelivered?.();
        } else if (
          rec.status === "refunded" ||
          rec.status === "expired" ||
          rec.status === "bridge_failed"
        ) {
          setPhase("error");
          // bridge_failed is held for manual resolution — keep the stream open
          // so a later move to delivered/refunded still lands.
          if (rec.status !== "bridge_failed") es.close();
        }
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [orderId]);

  const destinationAddress = useCustomAddress
    ? customAddress.trim()
    : walletAddress;

  const canSubmit =
    isConnected &&
    !isSubmitting &&
    parseFloat(amount) > 0 &&
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
    if (!canSubmit || !destinationAddress) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/onramp/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fiatAmount: amount,
          currency,
          userStellarAddress: destinationAddress,
          refundAccount: {
            institution: bank,
            accountIdentifier: accountNumber,
            accountName,
          },
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to create onramp order");
      }
      setOrderId(payload.data.id);
      setProviderAccount(payload.data.providerAccount);
      setStatus(payload.data.status || "pending");
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
  };

  // --- Render ---------------------------------------------------------------

  if (phase === "awaiting-deposit" && providerAccount) {
    return (
      <VirtualAccountView
        account={providerAccount}
        status={status}
        onCancel={reset}
      />
    );
  }

  if (phase === "processing" || phase === "done" || phase === "error") {
    return (
      <StatusView status={status} phase={phase} error={error} onReset={reset} />
    );
  }

  // form
  return (
    <section className="flex flex-col gap-[1.1rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]">
      <div>
        <h2 className="m-0 font-space-grotesk font-bold text-[1.50rem]">
          {isConnected ? "BUY USDC ON STELLAR" : "CONNECT WALLET"}
        </h2>
        <p className="mt-[0.3rem] mb-0 text-[0.75rem] text-[var(--muted)]">
          {isConnected
            ? "Pay fiat by bank transfer and receive USDC in your Stellar wallet."
            : "Connect a Stellar wallet to receive your USDC."}
        </p>
      </div>

      <div className="flex flex-col gap-[0.6rem]">
        <LabeledInput
          label={`AMOUNT IN ${currency}`}
          value={amount}
          onChange={setAmount}
          type="number"
          placeholder="0.00"
        />
        <div className="grid grid-cols-2 gap-[0.6rem] max-[720px]:grid-cols-1">
          <SelectField
            label="PAY WITH CURRENCY"
            value={currency}
            onChange={(v) => {
              setCurrency(v);
              setBank("");
              setAccountName("");
            }}
            options={currencies.map((c) => ({
              code: c.code,
              name: `${c.name} (${c.symbol})`,
            }))}
            isLoading={isLoadingCurrencies}
            placeholder="Select currency"
          />
          <LabeledInput
            label="REFUND ACCOUNT NUMBER"
            value={accountNumber}
            onChange={setAccountNumber}
            placeholder="0000000000"
            maxLength={10}
          />
          <SelectField
            label="REFUND BANK"
            value={bank}
            onChange={setBank}
            options={banks}
            isLoading={isLoadingBanks}
            placeholder="Select bank"
          />
        </div>
        <ReadOnlyField
          label="REFUND ACCOUNT NAME"
          value={isVerifying ? "Verifying…" : accountName || "—"}
          accent={!!accountName}
        />
        <p className="m-0 text-[0.68rem] text-[var(--muted)]">
          Refund details are used only if the order can’t be fulfilled.
        </p>
      </div>

      <div className="flex flex-col gap-[0.6rem]">
        <div className="border border-[var(--line)] bg-[#111] px-3 py-2">
          <p className="m-0 text-[1rem] text-[var(--accent)]">
            By default, USDC is sent to your{" "}
            <span className="text-[var(--foreground)]">connected wallet</span>{" "}
            address. Tick the box below to send it to a different Stellar
            address instead.
          </p>
        </div>
        <label className="flex items-center gap-[0.5rem] text-[1rem] text-[var(--muted)]">
          <input
            type="checkbox"
            checked={useCustomAddress}
            onChange={(e) => setUseCustomAddress(e.target.checked)}
            className="h-[14px] w-[14px] accent-[var(--accent)]"
          />
          Send to a different Stellar address
        </label>
        {useCustomAddress && (
          <LabeledInput
            label="DESTINATION STELLAR ADDRESS"
            value={customAddress}
            onChange={setCustomAddress}
            placeholder="G..."
          />
        )}
        {useCustomAddress &&
          customAddress.trim().length > 0 &&
          !isValidStellarAddress(customAddress.trim()) && (
            <p className="m-0 text-[0.7rem] text-red-400">
              Enter a valid Stellar address (starts with G, 56 characters).
            </p>
          )}
      </div>

      {error && <p className="m-0 text-[0.8rem] text-red-400">{error}</p>}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={isConnected ? !canSubmit : isConnecting}
        className={cn(
          "h-12 font-bold uppercase tracking-[0.08em] transition-colors",
          !isConnected &&
            "bg-[var(--accent)] text-[#0a0a0a] hover:brightness-110",
          isConnected &&
            !canSubmit &&
            "bg-[#2f2f2f] text-[var(--muted)] cursor-not-allowed",
          isConnected &&
            canSubmit &&
            "bg-[#efefef] text-[#0a0a0a] hover:brightness-95",
        )}
      >
        {!isConnected
          ? "CONNECT WALLET"
          : isSubmitting
            ? "CREATING ORDER…"
            : "GET DEPOSIT ACCOUNT →"}
      </button>
    </section>
  );
}

function VirtualAccountView({
  account,
  status,
  onCancel,
}: {
  account: ProviderAccount;
  status: string;
  onCancel: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, value: string) => {
    navigator.clipboard?.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <section className="flex flex-col gap-[1.1rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]">
      <div>
        <h2 className="m-0 font-space-grotesk font-bold text-[1.4rem]">
          SEND {account.currency} {account.amountToTransfer}
        </h2>
        <p className="mt-[0.3rem] mb-0 text-[0.75rem] text-[var(--muted)]">
          Transfer the exact amount to the account below. USDC is delivered to
          your Stellar wallet once received.
        </p>
      </div>

      <div className="flex flex-col gap-[0.5rem]">
        <CopyRow
          label="BANK"
          value={account.institution}
          copied={copied === "BANK"}
          onCopy={() => copy("BANK", account.institution)}
        />
        <CopyRow
          label="ACCOUNT NUMBER"
          value={account.accountIdentifier}
          copied={copied === "ACCOUNT NUMBER"}
          onCopy={() => copy("ACCOUNT NUMBER", account.accountIdentifier)}
        />
        <CopyRow
          label="ACCOUNT NAME"
          value={account.accountName}
          copied={copied === "ACCOUNT NAME"}
          onCopy={() => copy("ACCOUNT NAME", account.accountName)}
        />
        <CopyRow
          label="EXACT AMOUNT"
          value={`${account.amountToTransfer}`}
          copied={copied === "EXACT AMOUNT"}
          onCopy={() => copy("EXACT AMOUNT", account.amountToTransfer)}
        />
      </div>

      <Countdown validUntil={account.validUntil} />

      <div className="flex items-center gap-2 border border-[var(--line)] bg-[#111] px-3 py-2">
        <Spinner />
        <span className="text-[0.8rem] text-[var(--muted)]">
          {ONRAMP_STATUS_LABEL[status] ?? ONRAMP_STATUS_LABEL.pending}
        </span>
      </div>

      <button
        type="button"
        onClick={onCancel}
        className="h-10 border border-[var(--line)] text-[0.75rem] uppercase tracking-[0.08em] text-[var(--muted)] hover:text-[var(--foreground)]"
      >
        Cancel
      </button>
    </section>
  );
}

function StatusView({
  status,
  phase,
  error,
  onReset,
}: {
  status: string;
  phase: OnrampPhase;
  error: string | null;
  onReset: () => void;
}) {
  const isDone = phase === "done";
  const isError = phase === "error";
  return (
    <section className="flex min-h-[40vh] flex-col items-center justify-center gap-4 border border-[var(--line)] bg-[#0a0a0a] p-8 text-center">
      {isDone ? (
        <div className="text-[3rem]">✓</div>
      ) : isError ? (
        <div className="text-[3rem]">⚠</div>
      ) : (
        <Spinner large />
      )}
      <h2 className="m-0 font-space-grotesk text-[1.4rem] font-bold text-[var(--accent)]">
        {isDone ? "USDC DELIVERED" : isError ? "NEEDS ATTENTION" : "PROCESSING"}
      </h2>
      <p className="m-0 max-w-[26rem] text-[0.9rem] text-[var(--muted)]">
        {error ?? ONRAMP_STATUS_LABEL[status] ?? ONRAMP_STATUS_LABEL.unknown}
      </p>
      {(isDone || isError) && (
        <button
          type="button"
          onClick={onReset}
          className="mt-2 h-10 bg-[var(--accent)] px-6 text-[0.75rem] font-bold uppercase tracking-[0.08em] text-[#0a0a0a]"
        >
          New onramp
        </button>
      )}
    </section>
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
    <div className="text-[0.75rem] text-[var(--muted)]">
      {remaining > 0 ? (
        <>
          Expires in{" "}
          <span className="text-[var(--accent)]">
            {mins}:{secs.toString().padStart(2, "0")}
          </span>
        </>
      ) : (
        <span className="text-red-400">Order window expired</span>
      )}
    </div>
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
    <div className="flex items-center justify-between border border-[var(--line)] px-3 py-2">
      <div className="flex flex-col">
        <span className="text-[0.62rem] tracking-[0.08em] text-[var(--muted)]">
          {label}
        </span>
        <span className="text-[0.95rem] text-[var(--foreground)]">{value}</span>
      </div>
      <button
        type="button"
        onClick={onCopy}
        className="text-[0.65rem] uppercase tracking-[0.08em] text-[var(--accent)] hover:brightness-110"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Spinner({ large }: { large?: boolean }) {
  return (
    <span
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-[var(--muted)] border-t-[var(--accent)]",
        large ? "h-8 w-8" : "h-4 w-4",
      )}
    />
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <div className="flex flex-col gap-[0.4rem]">
      <label className="text-[0.69rem] tracking-[0.08em] text-[var(--muted)]">
        {label}
      </label>
      <div className="flex h-[46px] items-center border border-[var(--line)] px-[0.8rem]">
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          className="flex-1 bg-transparent text-[0.95rem] outline-none placeholder:text-[var(--muted)]"
        />
      </div>
    </div>
  );
}

function ReadOnlyField({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-[0.4rem]">
      <label className="text-[0.69rem] tracking-[0.08em] text-[var(--muted)]">
        {label}
      </label>
      <div className="flex h-[46px] items-center border border-[var(--line)] px-[0.8rem]">
        <span
          className={cn(
            "text-[0.95rem]",
            accent ? "text-[var(--accent)]" : "text-[var(--muted)]",
          )}
        >
          {value}
        </span>
      </div>
    </div>
  );
}
