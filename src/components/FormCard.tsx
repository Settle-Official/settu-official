"use client";

import { useState, useEffect, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { SelectField } from "@/components/SelectField";
import { PAYCREST_SENDER_FEE_RATE } from "@/lib/offramp/fee";

// e.g. 0.003 -> "0.3%" — drop trailing zeros so 0.5% doesn't render "0.50%".
const PAYCREST_FEE_PERCENT_LABEL = `${(PAYCREST_SENDER_FEE_RATE * 100).toFixed(2).replace(/\.?0+$/, "")}%`;

export interface FormCardProps {
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly isExecutingOfframp?: boolean;
  /** Increment to reset the form after a successful transaction */
  readonly resetKey?: number;
  readonly onConnect: () => void;
  readonly onInitiateOfframp?: (tradeData: {
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
  }) => Promise<void> | void;
  readonly onPricingUpdate?: (data: {
    amount: string;
    quote: Quote | null;
    isLoadingQuote: boolean;
    currency: string;
    gasFeeOptions: GasFeeOptions | null;
  }) => void;
}

export interface GasFeeOptions {
  fee: { int: string; float: string };
}

interface Bank {
  code: string;
  name: string;
}

interface Currency {
  code: string;
  name: string;
  symbol: string;
}

interface Quote {
  quoteId: string;
  sourceAmount: string;
  destinationAmount: string;
  rate: number;
  currency: string;
  estimatedTimeMs: number;
}

const PAYCREST_API_BASE = "https://api.paycrest.io/v1";

function isValidQuote(data: unknown): data is Quote {
  if (!data || typeof data !== "object") return false;
  const candidate = data as Partial<Quote>;
  return (
    typeof candidate.quoteId === "string" &&
    typeof candidate.sourceAmount === "string" &&
    typeof candidate.destinationAmount === "string" &&
    typeof candidate.currency === "string" &&
    typeof candidate.rate === "number" &&
    Number.isFinite(candidate.rate) &&
    typeof candidate.estimatedTimeMs === "number" &&
    Number.isFinite(candidate.estimatedTimeMs)
  );
}

function formatEstimatedTime(estimatedTimeMs: number): string {
  if (!Number.isFinite(estimatedTimeMs) || estimatedTimeMs <= 0) {
    return "-";
  }
  const totalSeconds = Math.max(1, Math.round(estimatedTimeMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} sec`;
  }
  const totalMinutes = Math.ceil(totalSeconds / 60);
  return `${totalMinutes} min`;
}

export function FormCard({
  isConnected,
  isConnecting,
  isExecutingOfframp = false,
  resetKey = 0,
  onConnect,
  onInitiateOfframp,
  onPricingUpdate,
}: Readonly<FormCardProps>) {
  const getCurrencyPrefix = (code?: string) =>
    (code || "NGN").toUpperCase() === "NGN"
      ? "₦"
      : (code || "NGN").toUpperCase();

  const [amount, setAmount] = useState("");
  // Which unit `amount` is currently denominated in. Switching modes clears
  // `amount` (and the quote) rather than trying to convert the existing
  // value — the conversion depends on a live rate, and showing a converted
  // guess before that resolves risks the user reading a stale number.
  const [amountMode, setAmountMode] = useState<"usdc" | "ngn">("usdc");
  const [accountNumber, setAccountNumber] = useState("");
  const [bank, setBank] = useState("");
  const [accountName, setAccountName] = useState("");
  const [currency, setCurrency] = useState("NGN");
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [isLoadingCurrencies, setIsLoadingCurrencies] = useState(false);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [isLoadingBanks, setIsLoadingBanks] = useState(false);
  const [isVerifyingAccount, setIsVerifyingAccount] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [isLoadingQuote, setIsLoadingQuote] = useState(false);

  const [gasFeeOptions, setGasFeeOptions] = useState<GasFeeOptions | null>(
    null,
  );
  const [isLoadingFees, setIsLoadingFees] = useState(false);

  // The USDC amount that will actually get burned, regardless of which unit
  // the user typed the amount in. In USDC mode this is just `amount`; in NGN
  // mode it's whatever the quote computed as the source amount for the
  // requested net payout (quote.sourceAmount) — never the raw NGN figure.
  // Everything that needs a real USDC number (the bridge-fee preview, the
  // 0.7 floor check, and — critically — what's actually submitted to
  // onInitiateOfframp) must read this, not `amount`, or NGN mode would try
  // to burn e.g. "5000" USDC for a ₦5000 request.
  const effectiveUsdcAmount =
    amountMode === "ngn" ? (quote?.sourceAmount ?? "") : amount;

  // Reset form fields when resetKey changes (after successful transaction)
  useEffect(() => {
    if (resetKey === 0) return; // skip initial mount
    setAmount("");
    setAccountNumber("");
    setBank("");
    setAccountName("");
    setQuote(null);
  }, [resetKey]);

  // Fetch gas fee options — the fee is a rate of the burn amount, so refetch
  // (debounced, same pattern as the quote fetch below) whenever the *USDC*
  // amount changes. In NGN mode that's effectiveUsdcAmount, which only
  // becomes known once the quote resolves — not the raw NGN input.
  useEffect(() => {
    const fetchGasFees = async () => {
      setIsLoadingFees(true);
      try {
        const query =
          effectiveUsdcAmount && parseFloat(effectiveUsdcAmount) > 0
            ? `?amount=${encodeURIComponent(effectiveUsdcAmount)}`
            : "";
        const res = await fetch(`/api/offramp/bridge/gas-fee-options${query}`);
        if (res.ok) {
          const data = await res.json();
          setGasFeeOptions(data.feeOptions);
        }
      } catch (err) {
      } finally {
        setIsLoadingFees(false);
      }
    };
    const debounce = setTimeout(fetchGasFees, 500);
    return () => clearTimeout(debounce);
  }, [effectiveUsdcAmount]);

  // Fetch supported currencies on mount
  useEffect(() => {
    const fetchCurrencies = async () => {
      setIsLoadingCurrencies(true);
      try {
        const response = await fetch(`${PAYCREST_API_BASE}/currencies`, {
          method: "GET",
        });
        if (!response.ok) {
          throw new Error(`Currencies request failed: ${response.status}`);
        }
        const data = await response.json();
        const supportedCurrencies = Array.isArray(data?.data) ? data.data : [];
        setCurrencies(supportedCurrencies);
        if (supportedCurrencies.some((c: Currency) => c.code === "NGN")) {
          setCurrency("NGN");
        } else if (supportedCurrencies[0]?.code) {
          setCurrency(supportedCurrencies[0].code);
        }
      } catch (error) {
      } finally {
        setIsLoadingCurrencies(false);
      }
    };

    fetchCurrencies();
  }, []);

  // Fetch banks when currency changes
  useEffect(() => {
    const fetchBanks = async () => {
      if (!currency) {
        setBanks([]);
        return;
      }
      setIsLoadingBanks(true);
      try {
        const response = await fetch(
          `${PAYCREST_API_BASE}/institutions/${encodeURIComponent(currency)}`,
          { method: "GET" },
        );
        if (!response.ok) {
          throw new Error(`Institutions request failed: ${response.status}`);
        }
        const data = await response.json();
        const institutions = Array.isArray(data?.data) ? data.data : [];
        setBanks(institutions);
      } catch (error) {
        setBanks([]);
      } finally {
        setIsLoadingBanks(false);
      }
    };

    fetchBanks();
  }, [currency]);

  // Verify account when both account number and bank are provided
  useEffect(() => {
    const verifyAccount = async () => {
      if (accountNumber.length === 10 && bank) {
        setIsVerifyingAccount(true);
        try {
          const response = await fetch(`${PAYCREST_API_BASE}/verify-account`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              institution: bank,
              accountIdentifier: accountNumber,
            }),
          });
          if (!response.ok) {
            throw new Error(`Verify account failed: ${response.status}`);
          }
          const data = await response.json();
          const resolvedAccountName =
            data?.data?.accountName || data?.data || data?.accountName || "";
          setAccountName(
            typeof resolvedAccountName === "string" ? resolvedAccountName : "",
          );
        } catch (error) {
          setAccountName("");
        } finally {
          setIsVerifyingAccount(false);
        }
      } else {
        setAccountName("");
      }
    };

    verifyAccount();
  }, [accountNumber, bank]);

  // Get quote when amount, currency, mode, or fee method changes. The 0.7
  // floor only means something in USDC terms — in NGN mode any positive
  // amount is worth quoting, and the server rejects a derived USDC amount
  // that's too small on its own (see /api/offramp/quote).
  useEffect(() => {
    const getQuote = async () => {
      const parsedAmount = parseFloat(amount);
      const meetsFloor =
        amountMode === "usdc" ? parsedAmount >= 0.7 : parsedAmount > 0;
      if (amount && meetsFloor) {
        setIsLoadingQuote(true);
        try {
          const response = await fetch("/api/offramp/quote", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              amount,
              token: "USDC",
              currency,
              network: "base",
              amountType: amountMode === "ngn" ? "fiat" : "crypto",
            }),
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(
              payload?.error || `Quote request failed: ${response.status}`,
            );
          }
          const payload = await response.json();
          const directQuote: Quote = {
            quoteId: payload.quoteId,
            sourceAmount: payload.sourceAmount,
            destinationAmount: payload.destinationAmount,
            rate: payload.rate,
            currency,
            estimatedTimeMs: payload.estimatedTime,
          };

          if (!isValidQuote(directQuote)) {
            setQuote(null);
            return;
          }
          setQuote(directQuote);
        } catch (error) {
          setQuote(null);
        } finally {
          setIsLoadingQuote(false);
        }
      } else {
        setQuote(null);
      }
    };

    const debounce = setTimeout(getQuote, 500);
    return () => clearTimeout(debounce);
  }, [amount, currency, amountMode]);

  useEffect(() => {
    onPricingUpdate?.({
      amount,
      quote,
      isLoadingQuote,
      currency,
      gasFeeOptions,
    });
  }, [amount, quote, isLoadingQuote, currency, gasFeeOptions, onPricingUpdate]);

  const getButtonText = () => {
    if (isExecutingOfframp) return "INITIATING OFFRAMP...";
    if (isConnecting) return "WAITING FOR SIGNATURE...";
    if (isConnected) return "INITIATE OFFRAMP →";
    return "CONNECT WALLET";
  };

  const handleAmountModeToggle = () => {
    setAmountMode((prev) => (prev === "usdc" ? "ngn" : "usdc"));
    setAmount("");
    setQuote(null);
  };

  const canInitiateOfframp =
    isConnected &&
    !isConnecting &&
    !isExecutingOfframp &&
    !!quote &&
    Number.parseFloat(effectiveUsdcAmount) >= 0.7 &&
    accountNumber.length === 10 &&
    !!bank &&
    !!accountName;

  const handlePrimaryAction = async () => {
    if (!isConnected) {
      onConnect();
      return;
    }

    if (!canInitiateOfframp || !quote || !onInitiateOfframp) return;

    await onInitiateOfframp({
      amount: effectiveUsdcAmount,
      rate: quote.rate,
      token: "USDC",
      beneficiary: {
        institution: bank,
        accountIdentifier: accountNumber,
        accountName,
        currency,
        memo: "Settu offramp",
      },
    });
  };

  return (
    <section className="flex flex-col gap-[1.1rem] border border-[var(--line)] bg-[#0a0a0a] p-[1.2rem]">
      <div>
        <h2 className="m-0 font-space-grotesk font-bold text-[1.50rem]">
          {isConnected
            ? "READY TO OFFRAMP"
            : isConnecting
              ? "CONNECTING WALLET"
              : "CONNECT WALLET"}
        </h2>
        <p className="mt-[0.3rem] mb-0 text-[0.75rem] text-[var(--muted)]">
          {isConnected
            ? "Connected wallet detected. Confirm amount and settument bank details."
            : isConnecting
              ? "Waiting for wallet signature before opening the off-ramp form."
              : "Securely connect a Stellar-compatible wallet before entering payout details."}
        </p>
      </div>

      <div className="flex flex-col gap-[0.6rem]">
        <InputField
          label={amountMode === "ngn" ? `AMOUNT IN ${currency}` : "AMOUNT IN USDC"}
          value={amount}
          onChange={setAmount}
          type="number"
          min={amountMode === "ngn" ? undefined : 0.7}
          step={amountMode === "ngn" ? "0.01" : "0.000001"}
          placeholder="0.00"
          labelAction={
            <button
              type="button"
              onClick={handleAmountModeToggle}
              className="text-[0.65rem] uppercase tracking-[0.06em] text-[var(--accent)] hover:brightness-110"
            >
              Switch to {amountMode === "ngn" ? "USDC" : currency} →
            </button>
          }
          suffix={
            isLoadingQuote
              ? "..."
              : quote
                ? amountMode === "ngn"
                  ? `≈ ${quote.sourceAmount} USDC`
                  : `≈ ${getCurrencyPrefix(quote.currency)} ${quote.destinationAmount}`
                : amountMode === "ngn"
                  ? undefined
                  : "Min 0.7 USDC"
          }
        />
        {/* Bridge fee — CCTP charges one real fee, deducted from the amount */}
        <div className="flex flex-col gap-[0.4rem]">
          <label className="text-[0.75rem] tracking-[0.08em] text-[var(--muted)]">
            BRIDGE FEE
          </label>
          {isLoadingFees ? (
            <p className="m-0 text-[0.8rem] text-[var(--muted)]">Loading...</p>
          ) : (
            gasFeeOptions &&
            parseFloat(effectiveUsdcAmount) > 0 && (
              <p className="m-0 text-[0.8rem] text-[var(--muted)]">
                {parseFloat(gasFeeOptions.fee.float).toFixed(4)} USDC — ~
                {Math.max(
                  0,
                  parseFloat(effectiveUsdcAmount) -
                    parseFloat(gasFeeOptions.fee.float),
                ).toFixed(4)}{" "}
                USDC bridged
              </p>
            )
          )}
        </div>
        <div className="grid grid-cols-2 gap-[0.6rem] max-[720px]:grid-cols-1">
          <SelectField
            label="OFFRAMP CURRENCY"
            value={currency}
            onChange={(value) => {
              setCurrency(value);
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
          <InputField
            label="ACCOUNT NUMBER"
            value={accountNumber}
            onChange={setAccountNumber}
            placeholder="0000000000"
            maxLength={10}
          />
          <SelectField
            label="BANK"
            value={bank}
            onChange={setBank}
            options={banks}
            isLoading={isLoadingBanks}
            placeholder="Select bank"
          />
        </div>
        <Field
          label="ACCOUNT NAME"
          value={isVerifyingAccount ? "Verifying..." : accountName || "—"}
          tone={accountName ? "accent" : "muted"}
        />
        {quote && (
          <div className="mt-2 p-3 bg-[#1a1a1a] border border-[var(--line)] rounded">
            <div className="text-[0.75rem] text-[var(--muted)] mb-1">
              ESTIMATED PAYOUT
            </div>
            <div className="text-[1.5rem] font-bold text-[var(--accent)]">
              {getCurrencyPrefix(quote.currency)}
              {quote.destinationAmount}
            </div>
            <div className="text-[0.7rem] text-[var(--muted)] mt-1">
              Est. time: {formatEstimatedTime(quote.estimatedTimeMs)}
              {" · "}Includes {PAYCREST_FEE_PERCENT_LABEL} fee
            </div>
            {gasFeeOptions && (
              <div className="text-[0.65rem] text-[var(--muted)] mt-0.5">
                Bridged: ~
                {Math.max(
                  0,
                  parseFloat(effectiveUsdcAmount) -
                    parseFloat(gasFeeOptions.fee.float),
                ).toFixed(4)}{" "}
                USDC → Base
              </div>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={handlePrimaryAction}
        disabled={
          !isConnected
            ? isConnecting || isExecutingOfframp
            : !canInitiateOfframp
        }
        className={cn(
          "h-12 font-bold uppercase tracking-[0.08em] transition-colors",
          !isConnected &&
            !isConnecting &&
            "bg-[var(--accent)] text-[#0a0a0a] hover:brightness-110",
          (isConnecting || isExecutingOfframp) &&
            "bg-[#2f2f2f] text-[var(--muted)] cursor-not-allowed",
          isConnected && "bg-[#efefef] text-[#0a0a0a] hover:brightness-95",
        )}
      >
        {getButtonText()}
      </button>
    </section>
  );
}

interface InputFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: string;
  readonly placeholder?: string;
  readonly suffix?: string;
  readonly disabled?: boolean;
  readonly maxLength?: number;
  readonly min?: number;
  readonly step?: string;
  /** Optional control rendered inline with the label — e.g. a unit switcher. */
  readonly labelAction?: ReactNode;
}

function InputField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  suffix,
  disabled,
  maxLength,
  min,
  step,
  labelAction,
}: Readonly<InputFieldProps>) {
  return (
    <div className="flex flex-col gap-[0.4rem]">
      <div className="flex items-center justify-between">
        <label className="text-[0.69rem] tracking-[0.08em] text-[var(--muted)]">
          {label}
        </label>
        {labelAction}
      </div>
      <div className="flex h-[46px] items-center justify-between gap-3 border border-[var(--line)] px-[0.8rem]">
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={maxLength}
          min={min}
          step={step}
          className={cn(
            "flex-1 bg-transparent text-[0.95rem] outline-none",
            "[appearance:textfield]",
            "[&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none",
            "[&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none",
            disabled && "cursor-not-allowed opacity-50",
            "placeholder:text-[var(--muted)]",
          )}
        />
        {suffix ? (
          <span className="text-[0.62rem] text-[var(--accent)]">{suffix}</span>
        ) : null}
      </div>
    </div>
  );
}

interface FieldProps {
  readonly label: string;
  readonly value: string;
  readonly suffix?: string;
  readonly tone?: "muted" | "accent";
}

function Field({ label, value, suffix, tone = "muted" }: Readonly<FieldProps>) {
  return (
    <div className="flex flex-col gap-[0.4rem]">
      <label className="text-[0.69rem] tracking-[0.08em] text-[var(--muted)]">
        {label}
      </label>
      <div className="flex h-[46px] items-center justify-between gap-3 border border-[var(--line)] px-[0.8rem]">
        <span
          className={cn(
            "text-[0.95rem]",
            tone === "accent" && "text-[var(--accent)]",
          )}
        >
          {value}
        </span>
        {suffix ? (
          <span className="text-[0.62rem] text-[var(--accent)]">{suffix}</span>
        ) : null}
      </div>
    </div>
  );
}
