"use client";

import type { ReactNode } from "react";
import { AppSelect } from "@/components/app/AppSelect";
import { BRIDGE_CHAIN_OPTIONS, type BridgeChainKey } from "@/lib/bridge/chains";

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/**
 * One From/To card: the side's label, its wallet pill, the chain dropdown
 * and whatever the side needs below (amount on From, address on To).
 */
export function BridgeLegCard({
  side,
  chain,
  onChainChange,
  wallet,
  isConnecting,
  onConnect,
  onDisconnect,
  children,
}: {
  readonly side: "From" | "To";
  readonly chain: BridgeChainKey;
  readonly onChainChange: (chain: BridgeChainKey) => void;
  readonly wallet?: string;
  readonly isConnecting: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-[14px] rounded-[20px] bg-[#2b2a2a] p-[24px] max-[720px]:rounded-[14px] max-[720px]:p-[16px]">
      <div className="flex items-center justify-between gap-[12px]">
        <span className="font-[family-name:var(--font-sora)] text-[20px] leading-[25px] text-[#bdbcbc] max-[720px]:text-[15px] max-[720px]:leading-[19px]">
          {side}
        </span>
        <button
          type="button"
          onClick={wallet ? onDisconnect : onConnect}
          disabled={isConnecting}
          title={wallet ? `Disconnect ${wallet}` : undefined}
          style={{ backgroundColor: "rgba(201,169,98,0.2)" }}
          className="flex h-[46px] min-w-[170px] items-center justify-center gap-[10px] whitespace-nowrap rounded-[40px] border border-white/15 px-[16px] font-[family-name:var(--font-inter)] text-[16px] text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)] backdrop-blur-xl transition-[filter] hover:brightness-150 disabled:cursor-not-allowed disabled:opacity-60 max-[720px]:h-[40px] max-[720px]:min-w-0 max-[720px]:text-[14px]"
        >
          {wallet && <span className="size-[9px] rounded-full bg-[#61c85e]" aria-hidden="true" />}
          {isConnecting ? "Connecting…" : wallet ? short(wallet) : "Connect wallet"}
        </button>
      </div>
      <AppSelect
        aria-label={`${side} chain`}
        value={chain}
        onChange={(v) => onChainChange(v as BridgeChainKey)}
        options={BRIDGE_CHAIN_OPTIONS}
      />
      {children}
    </div>
  );
}
