"use client";

import { useState } from "react";
import { CaretDownIcon } from "@/components/app/icons";
import { formatAtomic } from "@/lib/bridge/admin-units";
import { BRIDGE_CHAINS, type BridgeChainKey } from "@/lib/bridge/chains";
import type { LoadedQuote } from "@/lib/bridge/form-state";

const NATIVE_DECIMALS = { evm: 18, stellar: 7, solana: 9 } as const;
/** Breakdown USDC amounts are in CCTP's 6 decimals on every chain. */
const USDC_DECIMALS = 6;

const usdc = (atomic: string) => {
  const n = Number(formatAtomic(atomic, USDC_DECIMALS));
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
};

/** "You'll receive on {chain}" with the Show/Hide fee breakdown (spec §4). */
export function BridgeReceiveCard({
  source,
  dest,
  quote,
  isLoading,
  eta,
}: {
  readonly source: BridgeChainKey;
  readonly dest: BridgeChainKey;
  readonly quote: LoadedQuote | null;
  readonly isLoading: boolean;
  readonly eta: string;
}) {
  const [showFee, setShowFee] = useState(false);
  const b = quote?.breakdown;
  const send = b ? Number(b.sendAtomic) : 0;
  const feePct = b && send > 0 ? Math.round((Number(b.settuFeeShownAtomic) * 10_000) / send) / 100 : null;
  const native = BRIDGE_CHAINS[source];

  return (
    <div className="rounded-[20px] bg-[#232222] max-[720px]:rounded-[14px]">
      <div className="flex items-center justify-between gap-[20px] px-[30px] py-[20px] font-[family-name:var(--font-inter)] text-[16px] leading-[19px] text-white max-[720px]:gap-[10px] max-[720px]:px-[16px] max-[720px]:py-[16px]">
        <span className="flex min-w-0 flex-col gap-[4px]">
          <span className="text-[13px] leading-[16px] text-[#a19d9d] max-[720px]:text-[12px] max-[720px]:leading-[15px]">
            {isLoading ? "Getting your price…" : `You'll receive on ${BRIDGE_CHAINS[dest].label}`}
          </span>
          <span className="truncate text-[26px] font-semibold leading-[32px] text-[#c9a962] max-[720px]:text-[18px] max-[720px]:leading-[22px]">
            {b ? `${b.receiveIsMinimum ? "at least " : ""}${usdc(b.receiveAtomic)}` : "—"}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setShowFee((s) => !s)}
          aria-expanded={showFee}
          className="flex shrink-0 items-center gap-[10px] p-[10px] text-white max-[720px]:gap-[6px] max-[720px]:p-0 max-[720px]:text-[12px] max-[720px]:leading-[15px]"
        >
          {showFee ? "Hide fee" : "Show fee"}
          <CaretDownIcon size={18} className={`text-[#f4f2f2] transition-transform ${showFee ? "rotate-180" : ""}`} />
        </button>
      </div>
      <div className={`fee-reveal ${showFee ? "is-open" : ""}`}>
        <div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-[20px] gap-y-[12px] border-t border-white/10 px-[30px] py-[20px] font-[family-name:var(--font-inter)] text-[15px] leading-[19px] text-[#dcd6d6] max-[720px]:gap-x-[12px] max-[720px]:gap-y-[10px] max-[720px]:px-[16px] max-[720px]:py-[16px] max-[720px]:text-[12px] max-[720px]:leading-[16px]">
            <dt>You send</dt>
            <dd className="text-right text-white">{b ? usdc(b.sendAtomic) : "—"}</dd>
            <dt>Settu fee{feePct !== null ? ` (${feePct}%)` : ""}</dt>
            <dd className="text-right text-white">{b ? usdc(b.settuFeeShownAtomic) : "—"}</dd>
            <dt>Network fee on {BRIDGE_CHAINS[dest].label}</dt>
            <dd className="text-right text-white">
              {!b
                ? "—"
                : b.nativeFeeAtomic !== "0"
                  ? `${formatAtomic(b.nativeFeeAtomic, NATIVE_DECIMALS[native.family])} ${native.nativeSymbol} (paid separately)`
                  : usdc(b.networkFeeAtomic)}
            </dd>
            <dt>Estimated time</dt>
            <dd className="text-right text-white">{eta}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
