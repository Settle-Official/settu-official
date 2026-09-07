const MOBILE_ANNOUNCEMENT =
  "Settu is now available on mobile. You can add to home screen for easy access.";

export interface HeaderProps {
  readonly subtitle: string;
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly walletAddress?: string;
  readonly stellarUsdcBalance?: string | null;
  readonly stellarXlmBalance?: string | null;
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
        <div>
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
                  ? "XLM Balance: loading..."
                  : `XLM Balance: ${stellarXlmBalance ?? "0.00"}`}
              </p>
            </div>
          ) : null}
        </div>
      </header>
      <div className="marquee-outer -mx-[2.6rem] max-[720px]:-mx-4 bg-[#C9A962] lg:hidden">
        <div className="marquee-inner">
          <span>{MOBILE_ANNOUNCEMENT}</span>
          <span>{MOBILE_ANNOUNCEMENT}</span>
        </div>
      </div>
    </>
  );
}
