"use client";

import { useEffect, useState } from "react";
import { CheckIcon } from "@/components/app/icons";
import { ResultCard } from "@/components/app/ResultCard";
import { formatAtomic } from "@/lib/bridge/admin-units";
import { progressCopy } from "@/lib/bridge/bridge-flow";
import { BRIDGE_CHAINS, type BridgeChainKey } from "@/lib/bridge/chains";
import type { BridgeStatusView } from "@/lib/bridge/bridge-store";
import type { FlowPhase } from "./useBridgeFlow";

const usdc = (atomic: string) =>
  Number(formatAtomic(atomic, 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const short = (a?: string) => (!a ? "your wallet" : a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

const ghost =
  "flex h-[64px] w-[396px] max-w-full items-center justify-center rounded-[40px] font-[family-name:var(--font-sora)] text-[18px] text-white transition-[filter] hover:brightness-125 hover:[background-color:rgba(255,255,255,0.06)] max-[720px]:h-[58px] max-[720px]:w-full max-[720px]:text-[16px]";

/** Index of the active step, given the steps shown. */
function activeIndex(phase: FlowPhase, withApprove: boolean): number {
  const offset = withApprove ? 1 : 0;
  if (phase.kind !== "running") return -1;
  switch (phase.step) {
    case "approve":
      return 0;
    case "confirm":
      return offset;
    case "sending":
      return offset + 1;
    case "tracking": {
      const s = phase.view?.status;
      if (s === "delivering") return offset + 3;
      if (s === "completed") return offset + 5;
      return phase.view ? offset + 2 : offset + 1;
    }
  }
}

export function BridgeStatusPanel({
  phase,
  amount,
  source,
  dest,
  recipient,
  onClose,
  onConfirmNewPrice,
  onClaim,
}: {
  readonly phase: FlowPhase;
  readonly amount: string;
  readonly source: BridgeChainKey;
  readonly dest: BridgeChainKey;
  readonly recipient: string;
  readonly onClose: () => void;
  readonly onConfirmNewPrice: () => void;
  readonly onClaim: (view: BridgeStatusView) => Promise<void>;
}) {
  // "Approve USDC" shows only once the flow actually needed an approval.
  const [withApprove, setWithApprove] = useState(false);
  useEffect(() => {
    if (phase.kind === "running" && phase.step === "approve") setWithApprove(true);
  }, [phase]);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const src = BRIDGE_CHAINS[source];
  const dst = BRIDGE_CHAINS[dest];
  const sourceLink = (h?: string) => (h ? src.explorerTx(h) : undefined);

  const claimButton = (view?: BridgeStatusView) =>
    view?.canSelfClaim ? (
      <div className="flex w-full flex-col items-center gap-[8px]">
        <button
          type="button"
          disabled={claiming}
          onClick={async () => {
            setClaimError(null);
            setClaiming(true);
            try {
              await onClaim(view);
            } catch (e) {
              setClaimError(e instanceof Error ? e.message : "The claim didn't go through.");
            } finally {
              setClaiming(false);
            }
          }}
          style={{ border: "1px solid rgba(255,255,255,0.6)" }}
          className={ghost}
        >
          {claiming ? "Claiming…" : "Claim it yourself"}
        </button>
        <p className="text-center font-[family-name:var(--font-inter)] text-[13px] text-[#a19d9d]">
          Your {dst.label} wallet submits the delivery and pays its gas.
        </p>
        {claimError && <p className="text-center text-[13px] text-[#e07a7e]">{claimError}</p>}
      </div>
    ) : null;

  if (phase.kind === "reconfirm") {
    const b = phase.quote.breakdown;
    return (
      <div className="flex flex-col items-center gap-[24px]">
        <div className="flex w-[398px] max-w-full flex-col gap-[16px] rounded-[20px] bg-[#232222] px-[24px] py-[28px] text-center">
          <h2 className="font-[family-name:var(--font-sora)] text-[18px] text-white">Your price was refreshed</h2>
          <p className="font-[family-name:var(--font-sora)] text-[15px] leading-[23px] text-[#e6e2e2]">
            The last price was about to expire, so we fetched a new one. You&apos;ll now receive{" "}
            {b.receiveIsMinimum ? "at least " : ""}
            <b className="text-[#c9a962]">{usdc(b.receiveAtomic)} USDC</b> on {dst.label}.
          </p>
        </div>
        <button type="button" onClick={onConfirmNewPrice} className={`${ghost} text-[#111010]`} style={{ backgroundColor: "#ecc56f" }}>
          Continue with this price
        </button>
        <button type="button" onClick={onClose} className={ghost}>
          Cancel
        </button>
      </div>
    );
  }

  if (phase.kind === "done") {
    const v = phase.view;
    const received = v.receivedAtomic ?? v.receiveMinAtomic;
    return (
      <div className="flex flex-col items-center gap-[16px]">
        <ResultCard
          compact
          kind="success"
          title={`Done! ${usdc(received)} USDC arrived`}
          body={`Sent to ${short(v.recipient ?? recipient)} on ${dst.label}.`}
          actionLabel="View transaction"
          onAction={() => window.open(v.destTx ? dst.explorerTx(v.destTx) : src.explorerTx(v.sourceTx), "_blank", "noopener")}
        />
        <a href={`/app/offramp?chain=${dest}`} style={{ border: "1px solid rgba(255,255,255,0.6)" }} className={ghost}>
          Offramp to naira
        </a>
      </div>
    );
  }

  if (phase.kind === "error") {
    const sent = !!phase.txHash;
    return (
      <div className="flex flex-col items-center gap-[16px]">
        <ResultCard
          compact
          kind="failed"
          title={sent ? "This bridge didn't complete" : "Bridge not sent"}
          body={
            sent
              ? `${phase.message} Your USDC left your wallet, and Settu support can see this transfer.`
              : phase.message
          }
          actionLabel={sent ? "View transaction" : "Try again"}
          onAction={() => (sent ? window.open(sourceLink(phase.txHash), "_blank", "noopener") : onClose())}
        />
        {claimButton(phase.view)}
      </div>
    );
  }

  if (phase.kind === "stillGoing") {
    return (
      <div className="flex flex-col items-center gap-[16px]">
        <div className="flex w-[398px] max-w-full flex-col gap-[12px] rounded-[20px] bg-[#232222] px-[24px] py-[28px] text-center">
          <h2 className="font-[family-name:var(--font-sora)] text-[18px] text-white">Still on its way</h2>
          <p className="font-[family-name:var(--font-sora)] text-[15px] leading-[23px] text-[#e6e2e2]">
            We&apos;ll keep going in the background. You can close this screen; the USDC still arrives.
          </p>
          <a className="text-[14px] text-[#c9a962] underline" href={sourceLink(phase.txHash)} target="_blank" rel="noopener noreferrer">
            Source transaction
          </a>
          {phase.view?.destTx && (
            <a className="text-[14px] text-[#c9a962] underline" href={dst.explorerTx(phase.view.destTx)} target="_blank" rel="noopener noreferrer">
              Destination transaction
            </a>
          )}
        </div>
        {claimButton(phase.view)}
        <button type="button" onClick={onClose} style={{ border: "1px solid rgba(255,255,255,0.6)" }} className={ghost}>
          Close
        </button>
      </div>
    );
  }

  // Running: the stepper.
  const steps = [
    ...(withApprove ? ["Approve USDC"] : []),
    "Confirm transaction in wallet",
    `Sending from ${src.label}`,
    "Verifying the transfer",
    `Delivering on ${dst.label}`,
    "Arrived in your wallet",
  ];
  const at = activeIndex(phase, withApprove);
  const view = phase.kind === "running" ? phase.view : undefined;
  return (
    <div className="flex flex-col items-center gap-[20px]">
      <div className="flex w-[398px] max-w-full flex-col gap-[28px] rounded-[20px] bg-[#232222] px-[24px] py-[28px] max-[720px]:gap-[22px] max-[720px]:px-[20px] max-[720px]:py-[24px]">
        <h2 className="font-[family-name:var(--font-sora)] text-[18px] leading-[23px] text-white max-[720px]:text-[16px]">
          Bridging {amount} USDC
        </h2>
        <ol className="flex flex-col">
          {steps.map((label, i) => {
            const done = at > i;
            const current = at === i;
            const last = i === steps.length - 1;
            return (
              <li key={label} className="flex gap-[14px]">
                <div className="flex flex-col items-center">
                  <span
                    className={`flex size-[24px] shrink-0 items-center justify-center rounded-full border ${
                      done
                        ? "border-[#c9a962] bg-[#c9a962] text-[#1a1a1a]"
                        : current
                          ? "landing-offramp-spin border-dashed border-white"
                          : "border-[#6a6969]"
                    }`}
                  >
                    {done && <CheckIcon size={13} strokeWidth={2.6} />}
                  </span>
                  {!last && <span className="my-[4px] w-px flex-1 bg-[#4d4c4c]" />}
                </div>
                <span
                  className={`pb-[26px] font-[family-name:var(--font-sora)] text-[15px] leading-[24px] max-[720px]:pb-[22px] max-[720px]:text-[14px] ${
                    done ? "text-[#c9a962]" : current ? "text-white" : "text-[#8d8c8c]"
                  }`}
                >
                  {current && view?.fellBackToStandard ? progressCopy(view) : label}
                </span>
              </li>
            );
          })}
        </ol>
        {phase.kind === "running" && phase.txHash && (
          <a className="text-[14px] text-[#c9a962] underline" href={sourceLink(phase.txHash)} target="_blank" rel="noopener noreferrer">
            View source transaction
          </a>
        )}
      </div>
      {claimButton(view)}
    </div>
  );
}
