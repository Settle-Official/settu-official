import { AccountLink } from "@/components/auth/AccountLink";
import { enabledOfframpChainLabels } from "@/lib/cctp/evm-chains";

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} & ${items[items.length - 1]}`;
}

// Announces the multi-chain offramp when any non-Stellar source is enabled
// (reads the same NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED allowlist, so it
// never names a chain that isn't actually live); falls back to the
// mobile-install message otherwise. Computed at module load — build-time config.
const _offrampChains = enabledOfframpChainLabels();
const ANNOUNCEMENT =
  _offrampChains.length > 0
    ? `New — offramp your USDC straight from ${formatList(_offrampChains)}, on top of Stellar. Convert to your bank in minutes.`
    : "Settu is now available on mobile. You can add to home screen for easy access.";

export interface HeaderProps {
  readonly subtitle: string;
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly walletAddress?: string;
  readonly stellarUsdcBalance?: string | null;
  /** The gas-token balance (Stellar XLM by default, or an EVM native token). */
  readonly stellarXlmBalance?: string | null;
  /** Ticker for the gas-token row — "XLM" (default), "ETH", "POL", … */
  readonly nativeCurrencyLabel?: string;
  readonly isBalanceLoading?: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
}

export function Header({
  subtitle,
  isConnected,
  isConnecting,
  walletAddress,
  stellarUsdcBalance,
  stellarXlmBalance,
  nativeCurrencyLabel = "XLM",
  isBalanceLoading = false,
  onConnect,
  onDisconnect,
}: Readonly<HeaderProps>) {
  const buttonText = isConnecting
    ? "CONNECTING..."
    : isConnected && walletAddress
      ? `${walletAddress.slice(0, 8)}...${walletAddress.slice(-4)}`
      : "CONNECT WALLET";

  return (
    <>
      <header className="flex items-center justify-between gap-4 max-[720px]:items-start max-[720px]:flex-col">
        <div>
          <h1 className="m-0 font-space-grotesk font-bold tracking-[-0.04em] leading-none">
            <span className="text-[clamp(1.7rem,2.4vw,2.6rem)] text-[#C9A962]">$</span>
            <span className="text-[clamp(1.7rem,2.4vw,2.6rem)]">ETTU</span>
          </h1>
          <p className="mt-[0.35rem] mb-0 text-[0.88rem] text-[var(--muted)]">
            {subtitle}
          </p>
        </div>
        <div className="flex flex-col items-end">
          <div className="mb-[0.4rem]">
            <AccountLink />
          </div>
          <button
            type="button"
            onClick={isConnected ? onDisconnect : onConnect}
            disabled={isConnecting}
            className="min-w-[210px] border-4 border-[#C9A962] bg-[#101010] px-4 py-[0.7rem] text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-[#f4e1ad] rounded-none shadow-[0_0_0_1px_rgba(201,169,98,0.35)] transition-colors hover:bg-[#C9A962] hover:text-[#0a0a0a] focus:outline-none focus:ring-2 focus:ring-[#C9A962]/70 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {buttonText}
          </button>
          {isConnected ? (
            <div className="mt-2 flex flex-col items-end gap-[0.15rem]">
              <p className="m-0 text-right text-[0.85rem] text-[var(--muted)]">
                {isBalanceLoading
                  ? "USDC Balance: loading..."
                  : `USDC Balance: ${stellarUsdcBalance ?? "0.00"}`}
              </p>
              <p className="m-0 text-right text-[0.85rem] text-[var(--muted)]">
                {isBalanceLoading
                  ? `${nativeCurrencyLabel} Balance: loading...`
                  : `${nativeCurrencyLabel} Balance: ${stellarXlmBalance ?? "0.00"}`}
              </p>
            </div>
          ) : null}
        </div>
      </header>
      {/* Mobile-install message stays mobile-only; the chain announcement is
          shown on every viewport — it's the point. */}
      <div
        className={`marquee-outer -mx-[2.6rem] max-[720px]:-mx-4 bg-[#C9A962] ${
          _offrampChains.length > 0 ? "" : "lg:hidden"
        }`}
      >
        <div className="marquee-inner">
          <span>{ANNOUNCEMENT}</span>
          <span>{ANNOUNCEMENT}</span>
        </div>
      </div>
    </>
  );
}
