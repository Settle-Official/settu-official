"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/cn";
import { SelectField } from "@/components/SelectField";
import { MIN_USDC_AMOUNT } from "@/lib/offramp/fiat-conversion";
import {
  EVM_SOURCE_CHAINS,
  isChainEnabled,
  type EvmChainKey,
} from "@/lib/cctp/evm-chains";
import { isSolanaEnabled } from "@/lib/solana/config";
import { fiatSymbol } from "@/lib/format/currency";

export type OfframpSourceChainKey = "stellar" | EvmChainKey | "solana";

/**
 * "Stellar" plus every non-Stellar chain turned on via
 * NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED. Until that var lists something
 * this is just `[{ stellar }]` and the dropdown is hidden — today's
 * single-source flow, unchanged. Computed once at module load.
 */
const SOURCE_CHAIN_OPTIONS: { code: OfframpSourceChainKey; name: string }[] = [
  { code: "stellar", name: "Stellar" },
  ...Object.values(EVM_SOURCE_CHAINS)
    .filter((c) => isChainEnabled(c.key))
    .map((c) => ({ code: c.key as OfframpSourceChainKey, name: c.label })),
  ...(isSolanaEnabled()
    ? [{ code: "solana" as OfframpSourceChainKey, name: "Solana" }]
    : []),
];

export interface FormCardProps {
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly isExecutingOfframp?: boolean;
  /** Increment to reset the form after a successful transaction */
  readonly resetKey?: number;
  readonly onConnect: () => void;
  /** Which chain the USDC is coming from. "stellar" is the default/legacy path. */
  readonly sourceChain: OfframpSourceChainKey;
  readonly onSourceChainChange: (next: OfframpSourceChainKey) => void;
  /** Connected wallet address for the current source chain (EVM 0x… or Stellar G…). */
  readonly walletAddress?: string | null;
  readonly onInitiateOfframp?: (tradeData: {
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
  }) => Promise<void> | void;
  readonly onPricingUpdate?: (data: {
    amount: string;
    quote: Quote | null;
    isLoadingQuote: boolean;
    currency: string;
    gasFeeOptions: GasFeeOptions | null;
  }) => void;
  /** Raw USDC balance — never the formatted display string. */
  readonly usdcBalance?: number | null;
  readonly isLoadingBalance?: boolean;
}

/** Which side of the pair the user is typing in. */
export type AmountMode = "crypto" | "fiat";

export interface GasFeeOptions {
  fee: { int: string; float: string };
}

interface Bank {
  code: string;
  name: string;
  /** "bank" or "mobile_money" — UGX is mobile money only. */
  type?: string;
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
  /** Corridor floor in fiat, from the quote route. 0 when unknown. */
  minFiat?: number;
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
  sourceChain,
  onSourceChainChange,
  walletAddress = null,
  onInitiateOfframp,
  onPricingUpdate,
  usdcBalance = null,
  isLoadingBalance = false,
}: Readonly<FormCardProps>) {
  const [amount, setAmount] = useState("");
  const [amountMode, setAmountMode] = useState<AmountMode>("crypto");
  // Held outside `quote` so the corridor floor still shows when the amount is
  // blank or below it — i.e. exactly when the user needs to see it.
  const [minFiat, setMinFiat] = useState<number | null>(null);
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

  /**
   * The USDC actually being burned. In crypto mode that is what the user
   * typed; in fiat mode it is the amount the quote resolved, so anything
   * denominated in USDC (bridge fee, balance check, the order itself) must
   * read this rather than `amount`.
   */
  const burnUsdc =
    amountMode === "fiat"
      ? quote
        ? Number.parseFloat(quote.sourceAmount)
        : null
      : Number.parseFloat(amount) || null;

  // Paycrest supplies the symbol for every corridor (₦, KSh, USh, TSh), so
  // there is no need to hardcode one per currency.
  const getCurrencyPrefix = (code?: string) => {
    const target = (code || currency || "NGN").toUpperCase();
    // Paycrest's symbol wins when we have it; fiatSymbol supplies a known
    // symbol for the live corridors otherwise, and the bare code as a last
    // resort — never a wrong symbol.
    return fiatSymbol(target, currencies.find((c) => c.code === target)?.symbol);
  };

  const selectedBank = banks.find((b) => b.code === bank);
  const isMobileMoney = selectedBank?.type === "mobile_money";
  // Every UGX option is a mobile network, so "Bank" would be plainly wrong.
  const institutionLabel = banks.some((b) => b.type === "mobile_money")
    ? banks.every((b) => b.type === "mobile_money")
      ? "MOBILE NETWORK"
      : "BANK / MOBILE MONEY"
    : "BANK";

  const [gasFeeOptions, setGasFeeOptions] = useState<GasFeeOptions | null>(
    null,
  );
  const [isLoadingFees, setIsLoadingFees] = useState(false);

  // For a non-Stellar source: does the connected wallet hold enough of the
  // chain's native token (ETH / SOL / …) to pay for the burn it's about to
  // sign? Mirrors the Stellar XLM-reserve check.
  const [gasCheck, setGasCheck] = useState<{
    sufficient: boolean;
    nativeBalance: string;
    estimatedGasNative: string;
    nativeCurrencySymbol: string;
  } | null>(null);
  const isEvmSource = sourceChain !== "stellar" && sourceChain !== "solana";
  const isSolanaSource = sourceChain === "solana";
  const isExternalSource = isEvmSource || isSolanaSource;

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
  // (debounced, same pattern as the quote fetch below) whenever it changes.
  // Driven by the resolved USDC rather than the raw input: in fiat mode
  // `amount` is naira, and sending it here would price the fee against a
  // number thousands of times too large.
  useEffect(() => {
    const fetchGasFees = async () => {
      setIsLoadingFees(true);
      try {
        const params = new URLSearchParams({ sourceChain });
        if (burnUsdc && burnUsdc > 0) params.set("amount", String(burnUsdc));
        const res = await fetch(
          `/api/offramp/bridge/gas-fee-options?${params.toString()}`,
        );
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
  }, [burnUsdc, sourceChain]);

  // Native-gas pre-flight — don't let the user start an offramp that will
  // fail when the wallet asks them to pay for the burn. Advisory but a hard
  // INITIATE block when the balance is clearly short. EVM uses a gas
  // estimate (evm-gas-preflight); Solana's fees are near-fixed so a balance
  // read against a small floor (solana-balances) is enough.
  useEffect(() => {
    if (!isExternalSource || !isConnected || !walletAddress) {
      setGasCheck(null);
      return;
    }
    if (isEvmSource && !(burnUsdc && burnUsdc > 0)) {
      setGasCheck(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        let normalised: typeof gasCheck = null;
        if (isEvmSource) {
          const params = new URLSearchParams({
            address: walletAddress,
            chain: sourceChain,
            amount: String(burnUsdc),
          });
          const res = await fetch(
            `/api/offramp/bridge/evm-gas-preflight?${params.toString()}`,
          );
          if (!res.ok || cancelled) return;
          normalised = await res.json();
        } else {
          const res = await fetch(
            `/api/offramp/bridge/solana-balances?address=${walletAddress}`,
          );
          if (!res.ok || cancelled) return;
          const d = await res.json();
          normalised = {
            sufficient: d.sufficientForGas,
            nativeBalance: d.sol,
            estimatedGasNative: "0.005",
            nativeCurrencySymbol: "SOL",
          };
        }
        if (!cancelled) setGasCheck(normalised);
      } catch {
        // Network hiccup — keep the last result rather than hard-blocking.
      }
    };
    const debounce = setTimeout(run, 500);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
    };
  }, [isExternalSource, isEvmSource, isConnected, walletAddress, sourceChain, burnUsdc]);

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
      // Not every corridor uses 10-digit account numbers — UGX is mobile
      // money only, and KES/TZS mix banks with phone-number identifiers.
      if (/^\+?\d{6,20}$/.test(accountNumber.trim()) && bank) {
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
          // Some corridors (e.g. KES M-Pesa) return "OK" instead of a name.
          // Leave the field empty so the user can type it rather than
          // submitting the literal "OK" as the account holder.
          const name =
            typeof resolvedAccountName === "string" ? resolvedAccountName : "";
          setAccountName(name.trim().toUpperCase() === "OK" ? "" : name);
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

  // Get quote when amount, currency, or input mode changes
  useEffect(() => {
    const getQuote = async () => {
      // Don't fire requests we already know will be rejected. Typing "15000"
      // passes through 1, 15 and 150 — each of which is below the corridor
      // floor — and blanking the quote on every one of those is what makes the
      // derived USDC flicker as you type. `minFiat` is unknown until the route
      // has told us once, so the first sub-minimum amount still asks.
      const parsed = parseFloat(amount);
      const meetsFloor =
        amountMode === "fiat"
          ? parsed > 0 && (!minFiat || parsed >= minFiat)
          : parsed >= MIN_USDC_AMOUNT;
      if (amount && meetsFloor) {
        setIsLoadingQuote(true);
        try {
          const response = await fetch("/api/offramp/quote", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              amount,
              amountIn: amountMode,
              token: "USDC",
              currency,
              network: "base",
            }),
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            // A definitive "too small" answer carries the corridor floor with
            // it — remember it so subsequent keystrokes are filtered locally.
            if (payload?.code === "BELOW_MINIMUM") {
              if (typeof payload.minFiat === "number" && payload.minFiat > 0) {
                setMinFiat(payload.minFiat);
              }
              setQuote(null);
              return;
            }
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
            minFiat:
              typeof payload.minFiat === "number" ? payload.minFiat : undefined,
          };
          if (typeof payload.minFiat === "number" && payload.minFiat > 0) {
            setMinFiat(payload.minFiat);
          }

          if (!isValidQuote(directQuote)) {
            setQuote(null);
            return;
          }
          setQuote(directQuote);
        } catch (error) {
          // Keep the last good quote on a transient failure. Paycrest and the
          // markets endpoint both hiccup occasionally, and blanking the payout
          // and the USDC debit for one failed poll reads as the form resetting
          // itself. A stale quote is replaced as soon as the next one lands,
          // and the order route re-derives the rate anyway.
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

  // What actually leaves the wallet — always the quote's resolved USDC.
  const debitUsdc = quote ? Number.parseFloat(quote.sourceAmount) : null;

  // Advisory only — the balance can move between quote and signature, so
  // handleExecuteTrade keeps its own pre-flight as the authoritative gate.
  // A null balance means "still loading" or Horizon is unreachable: fall
  // through rather than making the form permanently unsubmittable.
  const shortfall =
    usdcBalance !== null && debitUsdc !== null && debitUsdc > usdcBalance
      ? debitUsdc - usdcBalance
      : 0;
  const hasInsufficientBalance = shortfall > 0;

  const meetsMinimum =
    amountMode === "fiat"
      ? !minFiat || Number.parseFloat(amount) >= minFiat
      : Number.parseFloat(amount) >= MIN_USDC_AMOUNT;

  // Only a definitive "insufficient" result blocks — a null check (not run
  // yet, or the check itself errored) never hard-blocks.
  const gasShort = isExternalSource && gasCheck?.sufficient === false;

  const getButtonText = () => {
    if (isExecutingOfframp) return "INITIATING OFFRAMP...";
    if (isConnecting) return "WAITING FOR SIGNATURE...";
    if (!isConnected) return "CONNECT WALLET";
    if (hasInsufficientBalance) return "INSUFFICIENT USDC BALANCE";
    if (gasShort)
      return `INSUFFICIENT ${gasCheck?.nativeCurrencySymbol ?? "GAS"} FOR GAS`;
    return "INITIATE OFFRAMP →";
  };

  const canInitiateOfframp =
    isConnected &&
    !isConnecting &&
    !isExecutingOfframp &&
    !!quote &&
    meetsMinimum &&
    !hasInsufficientBalance &&
    !gasShort &&
    /^\+?\d{6,20}$/.test(accountNumber.trim()) &&
    !!bank &&
    !!accountName;

  const handlePrimaryAction = async () => {
    if (!isConnected) {
      onConnect();
      return;
    }

    if (!canInitiateOfframp || !quote || !onInitiateOfframp) return;

    await onInitiateOfframp({
      // Always the resolved USDC, never the raw input — in fiat mode `amount`
      // is naira and would otherwise be bridged as USDC. In crypto mode the
      // route echoes the input back, so this is correct for both.
      amount: quote.sourceAmount,
      rate: quote.rate,
      token: "USDC",
      sourceChain,
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
              : sourceChain === "stellar"
                ? "Securely connect a Stellar-compatible wallet before entering payout details."
                : isSolanaSource
                  ? "Connect a Solana wallet (Phantom, Solflare…) before entering payout details."
                  : `Connect an EVM wallet on ${
                      SOURCE_CHAIN_OPTIONS.find((o) => o.code === sourceChain)?.name ??
                      sourceChain
                    } before entering payout details.`}
        </p>
      </div>

      <div className="flex flex-col gap-[0.6rem]">
        {/* Source chain — only rendered once more than one source is enabled
            (NEXT_PUBLIC_EVM_SOURCE_CHAINS_ENABLED). Switching it tears down the
            active wallet connection (Stellar and EVM can't be connected at
            once) and clears the amount/quote, since a fresh connect is
            required either way. */}
        {SOURCE_CHAIN_OPTIONS.length > 1 && (
          <SelectField
            label="SOURCE CHAIN"
            value={sourceChain}
            onChange={(value) => {
              if (value === sourceChain) return;
              setAmount("");
              setQuote(null);
              setMinFiat(null);
              onSourceChainChange(value as OfframpSourceChainKey);
            }}
            options={SOURCE_CHAIN_OPTIONS}
            placeholder="Select source chain"
          />
        )}
        {/* Enter either side of the pair. Switching carries the value across
            from the live quote so the user doesn't retype it. */}
        <div className="flex items-center gap-[0.35rem]">
          {(["crypto", "fiat"] as const).map((mode) => {
            const isActive = mode === amountMode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  if (isActive) return;
                  if (quote) {
                    setAmount(
                      mode === "fiat"
                        ? quote.destinationAmount
                        : quote.sourceAmount,
                    );
                  }
                  setAmountMode(mode);
                }}
                aria-pressed={isActive}
                // Inline styles, not bg-*/border-* utility classes — same
                // reason as the on-ramp/off-ramp toggle above: the global
                // unlayered `button { background: none; border: 0 }` reset
                // in globals.css always wins over layered Tailwind utilities
                // regardless of source order, so a class-based fill/border
                // here would silently drop just like that one did.
                style={{
                  border: `2px solid ${isActive ? "#C9A962" : "#3a3a3a"}`,
                  backgroundColor: isActive ? "#C9A962" : "#101010",
                  color: isActive ? "#0a0a0a" : "#f4e1ad",
                }}
                className="px-[0.6rem] py-[0.25rem] text-[0.62rem] font-bold uppercase tracking-[0.08em] transition-colors rounded-none"
              >
                {mode === "crypto" ? "USDC" : currency}
              </button>
            );
          })}
          <span className="ml-auto text-[0.62rem] text-[var(--muted)]">
            {amountMode === "fiat" ? "Amount to receive" : "Amount to send"}
          </span>
        </div>
        <InputField
          label={
            amountMode === "fiat" ? `AMOUNT IN ${currency}` : "AMOUNT IN USDC"
          }
          value={amount}
          onChange={setAmount}
          type="number"
          min={amountMode === "fiat" ? (minFiat ?? 0) : MIN_USDC_AMOUNT}
          step={amountMode === "fiat" ? "1" : "0.000001"}
          placeholder="0.00"
          suffix={
            isLoadingQuote
              ? "..."
              : quote
                ? amountMode === "fiat"
                  ? `≈ ${quote.sourceAmount} USDC`
                  : `≈ ${getCurrencyPrefix(quote.currency)} ${quote.destinationAmount}`
                : amountMode === "fiat"
                  ? `Min ${getCurrencyPrefix(currency)} ${minFiat?.toLocaleString("en-US") ?? "—"}`
                  : `Min ${MIN_USDC_AMOUNT} USDC`
          }
        />
        {/* What actually leaves the wallet, plus whether it is covered. */}
        {quote && debitUsdc !== null && (
          <div className="flex flex-col gap-[0.2rem]">
            <div className="flex items-baseline justify-between">
              <span className="text-[0.75rem] tracking-[0.08em] text-[var(--muted)]">
                YOU PAY
              </span>
              <span className="font-space-grotesk text-[0.9rem] font-bold">
                {quote.sourceAmount} USDC
              </span>
            </div>
            {isLoadingBalance ? (
              <span className="text-[0.68rem] text-[var(--muted)]">
                Checking balance...
              </span>
            ) : hasInsufficientBalance ? (
              <span className="text-[0.68rem] text-red-400">
                Short by {shortfall.toFixed(6)} USDC — you have{" "}
                {(usdcBalance ?? 0).toFixed(6)} USDC
              </span>
            ) : usdcBalance !== null ? (
              <span className="text-[0.68rem] text-[var(--muted)]">
                Balance {usdcBalance.toFixed(6)} USDC
              </span>
            ) : null}
            {/* Native-gas pre-flight — ETH / SOL, separate from the USDC balance above. */}
            {isExternalSource && gasCheck && (
              <span
                className={cn(
                  "text-[0.68rem]",
                  gasCheck.sufficient ? "text-[var(--muted)]" : "text-red-400",
                )}
              >
                {gasCheck.sufficient
                  ? `Gas: ~${Number(gasCheck.estimatedGasNative).toFixed(6)} ${gasCheck.nativeCurrencySymbol} (you have ${Number(gasCheck.nativeBalance).toFixed(6)})`
                  : `Insufficient ${gasCheck.nativeCurrencySymbol} for gas — you have ${Number(gasCheck.nativeBalance).toFixed(6)}, need ~${Number(gasCheck.estimatedGasNative).toFixed(6)}`}
              </span>
            )}
          </div>
        )}
        {/* Bridge fee — CCTP charges one real fee, deducted from the amount.
            Base as a source does a plain transfer with no bridge, so no fee. */}
        <div className="flex flex-col gap-[0.4rem]">
          <label className="text-[0.75rem] tracking-[0.08em] text-[var(--muted)]">
            BRIDGE FEE
          </label>
          {sourceChain === "base" ? (
            <p className="m-0 text-[0.8rem] text-[var(--muted)]">
              None — direct transfer on Base
            </p>
          ) : isLoadingFees ? (
            <p className="m-0 text-[0.8rem] text-[var(--muted)]">Loading...</p>
          ) : (
            gasFeeOptions &&
            burnUsdc !== null &&
            burnUsdc > 0 && (
              <p className="m-0 text-[0.8rem] text-[var(--muted)]">
                {parseFloat(gasFeeOptions.fee.float).toFixed(4)} USDC — ~
                {Math.max(
                  0,
                  burnUsdc - parseFloat(gasFeeOptions.fee.float),
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
              setMinFiat(null);
            }}
            options={currencies.map((c) => ({
              code: c.code,
              name: `${c.name} (${c.symbol})`,
            }))}
            isLoading={isLoadingCurrencies}
            placeholder="Select currency"
          />
          <InputField
            label={isMobileMoney ? "PHONE NUMBER" : "ACCOUNT NUMBER"}
            value={accountNumber}
            onChange={setAccountNumber}
            placeholder={isMobileMoney ? "0700000000" : "0000000000"}
            maxLength={20}
          />
          <SelectField
            label={institutionLabel}
            value={bank}
            onChange={setBank}
            options={banks}
            isLoading={isLoadingBanks}
            placeholder={
              isLoadingBanks ? "Loading..." : `Select ${institutionLabel.toLowerCase()}`
            }
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
              {" · "}Includes 0.3% platform fee
            </div>
            {gasFeeOptions && (
              <div className="text-[0.65rem] text-[var(--muted)] mt-0.5">
                Bridged: ~
                {Math.max(
                  0,
                  (burnUsdc ?? 0) - parseFloat(gasFeeOptions.fee.float),
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
}: Readonly<InputFieldProps>) {
  return (
    <div className="flex flex-col gap-[0.4rem]">
      <label className="text-[0.69rem] tracking-[0.08em] text-[var(--muted)]">
        {label}
      </label>
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
