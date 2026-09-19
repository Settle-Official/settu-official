"use client";

import { useState, useEffect } from "react";
import { AppSelect } from "@/components/app/AppSelect";
import { CaretDownIcon } from "@/components/app/icons";
import { OfframpStatusPanel } from "@/components/app/OfframpStatusPanel";
import type { OfframpStep } from "@/components/TransactionProgressModal";
import { MIN_USDC_AMOUNT } from "@/lib/offramp/fiat-conversion";
import { fiatSymbol } from "@/lib/format/currency";
import {
  sourceChainOptions,
  type OfframpSourceChainKey,
} from "@/lib/offramp/source-chain-options";
export type { OfframpSourceChainKey };

// Recomputed on every render (cheap — a handful of filter/map calls), unlike
// the old module-level constant, so a runtime env change during dev doesn't
// need a full reload to show up.
const SOURCE_CHAIN_OPTIONS = sourceChainOptions();

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
    destinationAmount: string;
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
  /**
   * The running flow, rendered in place of the form (processing steps,
   * done, failed). Omit to leave that to the caller's own modal.
   */
  readonly flow?: {
    readonly step: OfframpStep;
    readonly error: string | null;
    readonly failedAtStep: OfframpStep;
    readonly onCancel: () => void;
    readonly onClose: () => void;
    readonly onViewTransaction: () => void;
  };
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
  flow,
}: Readonly<FormCardProps>) {
  const [amount, setAmount] = useState("");
  const [amountMode, setAmountMode] = useState<AmountMode>("crypto");
  // Held outside `quote` so the corridor floor still shows when the amount is
  // blank or below it — i.e. exactly when the user needs to see it.
  const [minFiat, setMinFiat] = useState<number | null>(null);
  const [accountNumber, setAccountNumber] = useState("");
  const [bank, setBank] = useState("");
  const [accountName, setAccountName] = useState("");
  // True the instant Paycrest confirms the account exists, regardless of
  // whether a display name came back — NGN always returns one, but KES
  // (M-Pesa) and some other corridors return the literal "OK" instead.
  const [accountVerified, setAccountVerified] = useState(false);
  const [currency, setCurrency] = useState("NGN");
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [isLoadingCurrencies, setIsLoadingCurrencies] = useState(false);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [isLoadingBanks, setIsLoadingBanks] = useState(false);
  const [isVerifyingAccount, setIsVerifyingAccount] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [isLoadingQuote, setIsLoadingQuote] = useState(false);
  // Which fields the user has left, for inline validation copy.
  const [touched, setTouched] = useState<{ accountNumber?: boolean }>({});
  const [showFee, setShowFee] = useState(false);
  // Captured at submit: the form is reset the moment the flow succeeds, so
  // the done card can't read these from the fields.
  const [receipt, setReceipt] = useState<{
    fiat: string;
    bankName: string;
    accountNumber: string;
  } | null>(null);

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
          const raw =
            typeof resolvedAccountName === "string" ? resolvedAccountName.trim() : "";
          // Paycrest confirmed the account exists either way — some corridors
          // (e.g. KES M-Pesa) just return the literal "OK" instead of a real
          // name. NGN always returns one, so canInitiateOfframp below still
          // requires accountName specifically for NGN; every other currency
          // only needs accountVerified.
          setAccountVerified(!!raw);
          setAccountName(raw.toUpperCase() === "OK" ? "" : raw);
        } catch (error) {
          setAccountVerified(false);
          setAccountName("");
        } finally {
          setIsVerifyingAccount(false);
        }
      } else {
        setAccountVerified(false);
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

  // NGN's verify-account always returns a real name, so it's still required
  // there; every other currency (e.g. KES, which returns the literal "OK")
  // only needs Paycrest to have confirmed the account exists.
  const accountNameSatisfied =
    currency === "NGN" ? !!accountName : accountVerified;

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
    accountNameSatisfied;

  const handlePrimaryAction = async () => {
    if (!isConnected) {
      onConnect();
      return;
    }

    if (!canInitiateOfframp || !quote || !onInitiateOfframp) return;

    setReceipt({
      fiat: `${getCurrencyPrefix(quote.currency)}${Number(quote.destinationAmount).toLocaleString("en-US")}`,
      bankName: selectedBank?.name ?? bank,
      accountNumber,
    });
    await onInitiateOfframp({
      // Always the resolved USDC, never the raw input — in fiat mode `amount`
      // is naira and would otherwise be bridged as USDC. In crypto mode the
      // route echoes the input back, so this is correct for both.
      amount: quote.sourceAmount,
      rate: quote.rate,
      destinationAmount: quote.destinationAmount,
      token: "USDC",
      sourceChain,
      beneficiary: {
        institution: bank,
        accountIdentifier: accountNumber,
        // Never sent empty — falls back to the account number when Paycrest
        // confirmed the account but gave no name (see accountNameSatisfied).
        accountName: accountName || accountNumber,
        currency,
        memo: "Settu offramp",
      },
    });
  };

  const sourceChainLabel =
    SOURCE_CHAIN_OPTIONS.find((o) => o.code === sourceChain)?.name ?? sourceChain;

  // The running flow takes over the whole card — processing steps, then the
  // done or failed card — until the caller closes it.
  if (flow && flow.step !== "idle") {
    return (
      <OfframpStatusPanel
        step={flow.step}
        error={flow.error}
        failedAtStep={flow.failedAtStep}
        sourceChainLabel={sourceChainLabel}
        receipt={receipt}
        onCancel={flow.onCancel}
        onClose={flow.onClose}
        onViewTransaction={flow.onViewTransaction}
      />
    );
  }

  const accountNumberValid = /^\+?\d{6,20}$/.test(accountNumber.trim());
  const accountNumberError =
    touched.accountNumber && accountNumber && !accountNumberValid
      ? currency === "NGN"
        ? "Account number must be 10 digits"
        : "Enter a valid account number"
      : null;

  const buttonLabel = isExecutingOfframp
    ? "Processing"
    : isConnecting
      ? "Waiting for signature…"
      : !isConnected
        ? "Connect Wallet"
        : hasInsufficientBalance
          ? "Insufficient USDC balance"
          : gasShort
            ? `Insufficient ${gasCheck?.nativeCurrencySymbol ?? "gas"} for gas`
            : "Continue";

  const fieldLabel =
    "font-[family-name:var(--font-sora)] text-[20px] leading-[25px] text-[#bdbcbc]";
  const fieldBox =
    "flex h-[70px] w-full items-center gap-[10px] rounded-[20px] border px-[20px] font-[family-name:var(--font-sora)] text-[20px] leading-[25px] text-white transition-colors";
  const feeRow = "contents";

  return (
    <div className="flex flex-col gap-[30px]">
      <section className="flex flex-col gap-[30px]">
        <h2 className="font-[family-name:var(--font-inter)] text-[22px] leading-[27px] text-white">
          Withdrawal information
        </h2>

        <div className="grid grid-cols-2 gap-x-[106px] gap-y-[30px] max-[1100px]:grid-cols-1 max-[1100px]:gap-x-[20px]">
          <div className="flex flex-col gap-[14px]">
            <span className={fieldLabel}>Source chain</span>
            {/* Switching tears down the active wallet connection (Stellar and
                EVM can't be connected at once) and clears the amount/quote,
                since a fresh connect is required either way. */}
            <AppSelect
              aria-label="Source chain"
              value={sourceChain}
              onChange={(value) => {
                if (value === sourceChain) return;
                setAmount("");
                setQuote(null);
                setMinFiat(null);
                onSourceChainChange(value as OfframpSourceChainKey);
              }}
              options={SOURCE_CHAIN_OPTIONS}
              placeholder="Select"
            />
          </div>
          <div className="flex flex-col gap-[14px]">
            <span className={fieldLabel}>Payout Currency</span>
            <AppSelect
              aria-label="Payout currency"
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
              placeholder="Select"
            />
          </div>
        </div>

        <div className="flex flex-col gap-[10px] border-b-[0.4px] border-[#6a6969] pb-[20px]">
          <div className="flex flex-col gap-[14px]">
            <span className={fieldLabel}>
              {amountMode === "fiat" ? `Amount to receive (${currency})` : "Amount to withdraw"}
            </span>
            <div className={`${fieldBox} border-[#d7d6d6]/70 focus-within:border-[#d7d6d6]`}>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                // A focused number input still eats scroll-wheel ticks to bump
                // its value — blurring on wheel hands that scroll back to the page.
                onWheel={(e) => e.currentTarget.blur()}
                min={amountMode === "fiat" ? (minFiat ?? 0) : MIN_USDC_AMOUNT}
                step={amountMode === "fiat" ? "1" : "0.000001"}
                placeholder="0"
                aria-label={amountMode === "fiat" ? `Amount in ${currency}` : "Amount in USDC"}
                className="min-w-0 flex-1 bg-transparent font-[family-name:var(--font-inter)] text-[20px] leading-[24px] text-white outline-none placeholder:text-[#8d8c8c] [appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none"
              />
              {/* Enter either side of the pair; switching carries the value
                  across from the live quote so the user doesn't retype it. */}
              <div className="flex shrink-0 items-center gap-[4px] rounded-full bg-white/5 p-[3px]">
                {(["crypto", "fiat"] as const).map((mode) => {
                  const isActive = mode === amountMode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => {
                        if (isActive) return;
                        if (quote) {
                          setAmount(
                            mode === "fiat" ? quote.destinationAmount : quote.sourceAmount,
                          );
                        }
                        setAmountMode(mode);
                      }}
                      style={{
                        backgroundColor: isActive ? "rgba(201,169,98,0.35)" : "transparent",
                      }}
                      className={`rounded-full px-[12px] py-[5px] font-[family-name:var(--font-inter)] text-[14px] leading-[17px] transition-colors ${
                        isActive ? "text-white" : "text-[#bdbcbc]"
                      }`}
                    >
                      {mode === "crypto" ? "USDC" : currency}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-[10px] font-[family-name:var(--font-inter)] text-[16px] leading-[19px] text-white">
            <span>
              {amountMode === "fiat"
                ? `Min ${getCurrencyPrefix(currency)}${minFiat?.toLocaleString("en-US") ?? "—"}`
                : `Min ${MIN_USDC_AMOUNT} USDC`}
            </span>
            <span className="size-[6px] rounded-full bg-[#c4c4c4]" aria-hidden="true" />
            <span>
              {isLoadingBalance
                ? "Balance: checking…"
                : usdcBalance !== null
                  ? `Balance: ${usdcBalance.toFixed(2)} USDC`
                  : "Balance: —"}
            </span>
            {hasInsufficientBalance && (
              <>
                <span className="size-[6px] rounded-full bg-[#c4c4c4]" aria-hidden="true" />
                <span className="text-[#e07a7e]">Short by {shortfall.toFixed(2)} USDC</span>
              </>
            )}
            {isExternalSource && gasCheck && !gasCheck.sufficient && (
              <>
                <span className="size-[6px] rounded-full bg-[#c4c4c4]" aria-hidden="true" />
                <span className="text-[#e07a7e]">
                  Insufficient {gasCheck.nativeCurrencySymbol} for gas — you have{" "}
                  {Number(gasCheck.nativeBalance).toFixed(4)}, need ~
                  {Number(gasCheck.estimatedGasNative).toFixed(4)}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="rounded-[20px] bg-[#2b2a2a]">
          <div className="flex items-center justify-between gap-[20px] px-[30px] py-[20px] font-[family-name:var(--font-inter)] text-[16px] leading-[19px] text-white">
            {/* The payout is the number the user is actually deciding on, so
                it gets the size and weight; "You'll receive about" is only a
                label and steps back to match. */}
            <span className="flex min-w-0 flex-col gap-[4px]">
              <span className="text-[13px] leading-[16px] text-[#a19d9d]">
                {isLoadingQuote ? "Getting your rate…" : "You'll receive about"}
              </span>
              <span className="truncate text-[26px] font-semibold leading-[32px] text-[#c9a962] max-[600px]:text-[22px] max-[600px]:leading-[28px]">
                {quote
                  ? `${getCurrencyPrefix(quote.currency)}${Number(quote.destinationAmount).toLocaleString("en-US")}`
                  : "—"}
              </span>
            </span>
            <button
              type="button"
              onClick={() => setShowFee((s) => !s)}
              aria-expanded={showFee}
              className="flex shrink-0 items-center gap-[10px] p-[10px] text-white"
            >
              {showFee ? "Hide fee" : "Show fee"}
              <CaretDownIcon
                size={18}
                className={`text-[#f4f2f2] transition-transform ${showFee ? "rotate-180" : ""}`}
              />
            </button>
          </div>
          {showFee && (
            <dl className="grid grid-cols-[1fr_auto] gap-x-[20px] gap-y-[12px] border-t border-white/10 px-[30px] py-[20px] font-[family-name:var(--font-inter)] text-[15px] leading-[19px] text-[#dcd6d6]">
              <div className={feeRow}>
                <dt>You pay</dt>
                <dd className="text-right text-white">
                  {quote ? `${quote.sourceAmount} USDC` : "—"}
                </dd>
              </div>
              <div className={feeRow}>
                <dt>Rate</dt>
                <dd className="text-right text-white">
                  {quote ? `1 USDC = ${getCurrencyPrefix(quote.currency)}${quote.rate.toLocaleString("en-US")}` : "—"}
                </dd>
              </div>
              <div className={feeRow}>
                <dt>Platform fee</dt>
                <dd className="text-right text-white">0.3% (included)</dd>
              </div>
              <div className={feeRow}>
                <dt>Bridge fee</dt>
                <dd className="text-right text-white">
                  {/* CCTP charges one real fee, deducted from the amount. Base
                      as a source is a plain transfer with no bridge. */}
                  {sourceChain === "base"
                    ? "None — direct transfer on Base"
                    : isLoadingFees
                      ? "…"
                      : gasFeeOptions && burnUsdc !== null && burnUsdc > 0
                        ? `${parseFloat(gasFeeOptions.fee.float).toFixed(4)} USDC (~${Math.max(0, burnUsdc - parseFloat(gasFeeOptions.fee.float)).toFixed(4)} USDC bridged)`
                        : "—"}
                </dd>
              </div>
              {isExternalSource && gasCheck?.sufficient && (
                <div className={feeRow}>
                  <dt>Network gas</dt>
                  <dd className="text-right text-white">
                    ~{Number(gasCheck.estimatedGasNative).toFixed(6)} {gasCheck.nativeCurrencySymbol}{" "}
                    (you have {Number(gasCheck.nativeBalance).toFixed(4)})
                  </dd>
                </div>
              )}
              <div className={feeRow}>
                <dt>Estimated time</dt>
                <dd className="text-right text-white">
                  {quote ? formatEstimatedTime(quote.estimatedTimeMs) : "—"}
                </dd>
              </div>
            </dl>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-[30px]">
        <h2 className="font-[family-name:var(--font-inter)] text-[22px] leading-[27px] text-white">
          Bank information
        </h2>
        <div className="grid grid-cols-2 gap-x-[106px] gap-y-[30px] max-[1100px]:grid-cols-1 max-[1100px]:gap-x-[20px]">
          <div className="flex flex-col gap-[10px]">
            <div className="flex flex-col gap-[14px]">
              <span className={fieldLabel}>
                {isMobileMoney ? "Phone number" : "Account number"}
              </span>
              <div
                className={`${fieldBox} ${
                  accountNumberError
                    ? "border-[#ac4747]"
                    : "border-[#d7d6d6]/70 focus-within:border-[#d7d6d6]"
                }`}
              >
                <input
                  type="text"
                  inputMode="numeric"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, accountNumber: true }))}
                  maxLength={20}
                  placeholder={isMobileMoney ? "0700000000" : "0123456789"}
                  aria-label={isMobileMoney ? "Phone number" : "Account number"}
                  aria-invalid={!!accountNumberError}
                  className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[#8d8c8c]"
                />
              </div>
            </div>
            {accountNumberError && (
              <span className="font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-[#ac4747]">
                {accountNumberError}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-[14px]">
            <span className={fieldLabel}>
              {institutionLabel === "BANK"
                ? "Bank"
                : institutionLabel === "MOBILE NETWORK"
                  ? "Mobile network"
                  : "Bank / mobile money"}
            </span>
            <AppSelect
              aria-label="Bank"
              value={bank}
              onChange={setBank}
              options={banks}
              isLoading={isLoadingBanks}
              placeholder="Select"
            />
          </div>
        </div>
        <div className="flex flex-col gap-[14px]">
          <span className={fieldLabel}>Account name</span>
          <div
            className={`${fieldBox} border-[#d7d6d6]/70 ${
              accountName || accountVerified ? "text-white" : "text-[#8d8c8c]"
            }`}
            aria-live="polite"
          >
            {isVerifyingAccount
              ? "Verifying…"
              : accountName
                ? accountName
                : accountVerified
                  ? "Verified (name unavailable)"
                  : "-"}
          </div>
        </div>
      </section>

      <button
        type="button"
        onClick={handlePrimaryAction}
        disabled={
          !isConnected ? isConnecting || isExecutingOfframp : !canInitiateOfframp
        }
        // Inline: globals.css's unlayered `button { background: none }` reset
        // beats layered bg-* utilities.
        style={{ backgroundColor: "#ecc56f" }}
        className="flex h-[80px] w-full items-center justify-center gap-[12px] rounded-[40px] font-[family-name:var(--font-sora)] text-[20px] font-semibold leading-[25px] text-[#111010] transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {buttonLabel}
        {isExecutingOfframp && (
          <span
            className="landing-offramp-spin inline-block size-[22px] rounded-full border-2 border-dashed border-[#111010]"
            aria-hidden="true"
          />
        )}
      </button>
    </div>
  );
}
