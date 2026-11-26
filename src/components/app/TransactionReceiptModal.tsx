"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CloseIcon } from "./icons";
import type { HistoryRow } from "./useWalletHistory";
import { buildReceipt } from "@/lib/receipt/receipt-data";
import { drawReceipt } from "@/lib/receipt/draw-receipt";
import { canRepeat, stashRepeat } from "@/lib/offramp/repeat-transfer";

const STATUS_COLOR: Record<HistoryRow["status"], string> = {
  completed: "#109F21",
  pending: "#C9A962",
  failed: "#CA4C4C",
};

type ShareState = "idle" | "working" | "shared" | "failed";

export function TransactionReceiptModal({
  row,
  onClose,
}: {
  readonly row: HistoryRow;
  readonly onClose: () => void;
}) {
  const router = useRouter();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [share, setShare] = useState<ShareState>("idle");

  const receipt = useMemo(() => buildReceipt(row), [row]);
  const repeatable = canRepeat(row);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Share where the platform supports it (phones), download otherwise. The
  // file is built either way, so the fallback is the same image.
  async function handleShare() {
    setShare("working");
    try {
      const blob = await drawReceipt(receipt);
      if (!blob) throw new Error("Could not render the receipt");

      const file = new File([blob], `settu-receipt-${row.id.slice(0, 10)}.png`, {
        type: "image/png",
      });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: receipt.title });
        setShare("shared");
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      link.click();
      URL.revokeObjectURL(url);
      setShare("shared");
    } catch (error) {
      // Dismissing the share sheet rejects too, and that is not a failure.
      const aborted = (error as Error)?.name === "AbortError";
      setShare(aborted ? "idle" : "failed");
    }
  }

  function handleRepeat() {
    stashRepeat({
      amountUsdc: String(row.usdc),
      currency: row.currency,
      institution: row.bank!,
      accountIdentifier: row.accountNumber!,
      accountName: row.accountName!,
      ...(row.sourceChain ? { sourceChain: row.sourceChain } : {}),
    });
    onClose();
    router.push("/app/offramp");
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="receipt-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-[20px] max-[720px]:p-[12px]"
    >
      <button
        type="button"
        aria-label="Close receipt"
        onClick={onClose}
        style={{ backgroundColor: "rgba(0,0,0,0.7)" }}
        className="absolute inset-0 backdrop-blur-sm"
      />

      <div
        style={{ border: "1px solid rgba(255,255,255,0.15)" }}
        className="relative z-10 flex max-h-[85vh] w-full max-w-[520px] flex-col gap-[20px] rounded-[30px] bg-[#1e1c1c] p-[32px] shadow-[0_28px_60px_rgba(0,0,0,0.6)] max-[720px]:max-h-[86dvh] max-[720px]:gap-[16px] max-[720px]:rounded-[20px] max-[720px]:p-[20px]"
      >
        <div className="flex items-start justify-between gap-[16px]">
          <div className="flex min-w-0 flex-col gap-[6px]">
            <h2
              id="receipt-title"
              className="font-fraunces text-[24px] leading-[31px] text-white max-[720px]:text-[19px] max-[720px]:leading-[25px]"
            >
              {receipt.title}
            </h2>
            <span
              style={{ color: STATUS_COLOR[row.status] }}
              className="font-[family-name:var(--font-sora)] text-[13px] leading-[17px]"
            >
              {receipt.status}
            </span>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-[36px] shrink-0 items-center justify-center rounded-full text-[#cfcdcd] transition-colors hover:text-white max-[720px]:size-[32px]"
          >
            <CloseIcon size={18} />
          </button>
        </div>

        <p className="font-fraunces text-[34px] leading-[42px] text-white max-[720px]:text-[28px] max-[720px]:leading-[34px]">
          {receipt.headline}
        </p>

        <dl
          data-lenis-prevent
          className="flex min-h-0 flex-col gap-[2px] overflow-y-auto overscroll-contain"
        >
          {receipt.fields.map((field) => (
            <div
              key={field.label}
              style={{ borderTop: "1px solid #2b2929" }}
              className="flex items-baseline justify-between gap-[20px] py-[12px] max-[600px]:flex-col max-[600px]:gap-[4px]"
            >
              <dt className="shrink-0 font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-[#a19d9d] max-[720px]:text-[12px]">
                {field.label}
              </dt>
              <dd className="min-w-0 break-words text-right font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-white max-[600px]:text-left max-[720px]:text-[13px]">
                {field.value}
              </dd>
            </div>
          ))}
          <div
            style={{ borderTop: "1px solid #2b2929" }}
            className="flex items-baseline justify-between gap-[20px] py-[12px] max-[600px]:flex-col max-[600px]:gap-[4px]"
          >
            <dt className="shrink-0 font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-[#a19d9d] max-[720px]:text-[12px]">
              Reference
            </dt>
            <dd className="min-w-0 break-all text-right font-mono text-[13px] leading-[18px] text-[#d6d3d3] max-[600px]:text-left">
              {receipt.reference}
            </dd>
          </div>
        </dl>

        <div className="flex gap-[10px] max-[600px]:flex-col">
          <button
            type="button"
            onClick={handleShare}
            disabled={share === "working"}
            style={{ border: "1px solid rgba(255,255,255,0.18)" }}
            className="h-[48px] flex-1 rounded-full font-[family-name:var(--font-sora)] text-[15px] text-white transition-colors hover:bg-[rgba(255,255,255,0.06)] disabled:opacity-60"
          >
            {share === "working"
              ? "Preparing…"
              : share === "shared"
                ? "Saved"
                : share === "failed"
                  ? "Couldn't save — retry"
                  : "Share receipt"}
          </button>

          {repeatable && (
            <button
              type="button"
              onClick={handleRepeat}
              className="h-[48px] flex-1 rounded-full bg-[#c9a962] font-[family-name:var(--font-sora)] text-[15px] font-semibold text-[#1a1a1a] transition-opacity hover:opacity-90"
            >
              Repeat transfer
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
