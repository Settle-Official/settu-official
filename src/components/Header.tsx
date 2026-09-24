import { SettuLogo } from "@/components/brand/SettuLogo";
import { AccountLink } from "@/components/auth/AccountLink";

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
    <header className="flex items-center justify-between gap-4 max-[720px]:items-start max-[720px]:flex-col">
      <div>
        {/* The logo's own label ("Settu") becomes the heading's name. */}
        <h1 className="m-0 leading-none">
          <SettuLogo className="h-[clamp(1.7rem,2.4vw,2.6rem)] w-auto" />
        </h1>
        <p className="mt-[0.35rem] mb-0 text-[0.88rem] text-[var(--muted)]">
          {subtitle}
        </p>
      </div>
      <div className="flex flex-col items-end">
        {/* Accounts are still being built, so the way in stays dev-only.
            Next inlines NODE_ENV, so this drops out of the prod bundle. */}
        {process.env.NODE_ENV !== "production" && (
          <div className="mb-[0.4rem]">
            <AccountLink />
          </div>
        )}
        <button
          type="button"
          onClick={isConnected ? onDisconnect : onConnect}
          disabled={isConnecting}
          className="min-w-[210px] border-4 border-[var(--accent)] bg-[var(--surface)] px-4 py-[0.7rem] text-[0.75rem] font-semibold uppercase tracking-[0.08em] text-[var(--accent)] rounded-none shadow-[0_0_0_1px_rgba(201,169,98,0.35)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--accent-contrast)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/70 disabled:opacity-60 disabled:cursor-not-allowed"
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
  );
}
