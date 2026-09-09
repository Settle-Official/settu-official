import type { RecentTransactionRow } from "@/types/stellaramp";
import { PlatformStatsCard } from "@/components/PlatformStatsCard";
import { formatFiat, fiatSymbol } from "@/lib/format/currency";

export interface PlatformStats {
  totalUsers: number;
  totalVolume: number;
  recentTransactions: RecentTransactionRow[];
}

export interface RightPanelProps {
  readonly stats?: PlatformStats | null;
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly amount: string;
  readonly quote: {
    destinationAmount: string;
    rate: number;
    currency: string;
  } | null;
  readonly isLoadingQuote: boolean;
  readonly currency: string;
  readonly onConnect: () => void;
}

export function RightPanel({
  stats,
  isConnected,
  isConnecting,
  amount,
  quote,
  isLoadingQuote,
  currency,
  onConnect,
}: Readonly<RightPanelProps>) {
  const parsedAmount = Number.parseFloat(amount || "0");
  const hasAmount = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const estimatedPayoutNgn =
    hasAmount && quote?.destinationAmount
      ? Number.parseFloat(quote.destinationAmount)
      : null;

  const formatAmount = (value: number, selectedCurrency: string) =>
    formatFiat(value, selectedCurrency);

  const formatCurrencyPrefix = (selectedCurrency: string) =>
    fiatSymbol(selectedCurrency);

  const getHeroLabel = () => {
    if (isConnecting) return "CONNECTING";
    if (isConnected) return "READY TO PAYOUT";
    return "WALLET REQUIRED";
  };

  const getHeroValue = () => {
    if (isConnecting) return "Awaiting signature";
    if (!isConnected || !hasAmount)
      return `${formatCurrencyPrefix(currency)} --`;
    if (isLoadingQuote) return "Calculating...";
    if (!estimatedPayoutNgn || !Number.isFinite(estimatedPayoutNgn))
      return `${formatCurrencyPrefix(currency)} --`;
    return formatAmount(
      estimatedPayoutNgn,
      currency || quote?.currency || "NGN",
    );
  };

  const getHeroMeta = () => {
    if (isConnecting) return "Approve connection in your wallet to continue";
    if (isConnected && hasAmount) return "Estimated payout after platform fee";
    if (isConnected) return "Enter amount to preview payout";
    return "Connect wallet to preview payout";
  };

  // const getFxRateValue = () => {
  //   if (!hasAmount) return "-";
  //   if (isLoadingQuote) return "Loading...";
  //   if (!quote?.rate) return "-";
  //   return `${formatCurrencyPrefix(currency || quote?.currency || "NGN")} ${quote.rate.toFixed(2)} / USDC`;
  // };

  const getPayoutTotal = () => {
    if (!hasAmount) return `${formatCurrencyPrefix(currency)} --`;
    if (isLoadingQuote) return "Calculating...";
    if (!estimatedPayoutNgn || !Number.isFinite(estimatedPayoutNgn))
      return `${formatCurrencyPrefix(currency)} --`;
    return formatAmount(
      estimatedPayoutNgn,
      currency || quote?.currency || "NGN",
    );
  };

  return (
    <aside className="flex flex-col gap-3">
      {isConnected ? (
        <section
          className={
            isConnecting
              ? "bg-[var(--accent)] p-[1.3rem] text-[#0a0a0a] [animation:pulse_1.2s_ease-in-out_infinite]"
              : "bg-[var(--accent)] p-[1.3rem] text-[#0a0a0a]"
          }
        >
          <p className="m-0 text-[0.75rem] tracking-[0.08em]">
            {getHeroLabel()}
          </p>
          <h3 className="my-[0.35rem] font-bold font-space-grotesk text-[clamp(2.5rem,2.2vw,2.5rem)] leading-none">
            {getHeroValue()}
          </h3>
          <p className="m-0 text-[0.75rem]">{getHeroMeta()}</p>
        </section>
      ) : (
        <section className="bg-[var(--accent)] p-[1.3rem] text-[#0a0a0a]">
          <button
            type="button"
            onClick={onConnect}
            disabled={isConnecting}
            className="w-full border border-[#0a0a0a] px-4 py-3 text-[0.72rem] font-bold uppercase tracking-[0.08em] hover:bg-[#0a0a0a] hover:text-[var(--accent)] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isConnecting ? "CONNECTING..." : "CONNECT WALLET"}
          </button>
        </section>
      )}

      <section className="border border-[var(--line)] bg-[#0a0a0a] p-4">
        <h3 className="mt-0 mb-[0.65rem] font-bold font-space-grotesk text-[1.13rem]">
          SETTUMENT BREAKDOWN
        </h3>
        {/* <div className="flex items-center justify-between py-[0.35rem] text-[0.72rem] text-[var(--muted)]">
          <span>FX Rate</span>
          <span className="text-white">{getFxRateValue()}</span>
        </div> */}
        <div className="flex items-center justify-between py-[0.35rem] text-[0.72rem] text-[var(--muted)]">
          <span>Network fee</span>
          <span className="text-white">-</span>
        </div>
        <div className="flex items-center justify-between py-[0.35rem] text-[0.72rem] text-[var(--muted)]">
          <span>Platform fee</span>
          <span className="text-white">-</span>
        </div>
        <div className="my-[0.45rem] h-px bg-[var(--line)]" />
        <div className="flex items-center justify-between py-[0.35rem] text-[0.72rem] font-bold text-[var(--accent)]">
          <span>Payout Total</span>
          <span className="font-space-grotesk text-[1.5rem] text-[var(--accent)]">
            {getPayoutTotal()}
          </span>
        </div>
      </section>

      <PlatformStatsCard stats={stats} />
    </aside>
  );
}
