"use client";

import { useState } from "react";
import { ResultCard } from "@/components/app/ResultCard";

/**
 * Both result cards side by side, as the ramps show them. "Replay" remounts
 * a card, which restarts its animation from the first frame.
 */
export function ResultIconsPreview() {
  const [runs, setRuns] = useState({ success: 0, failed: 0 });
  const replay = (kind: keyof typeof runs) =>
    setRuns((r) => ({ ...r, [kind]: r[kind] + 1 }));

  return (
    <main className="mx-auto flex max-w-[960px] flex-col gap-[32px] px-[16px] py-[40px]">
      <header className="flex flex-wrap items-center justify-between gap-[16px]">
        <h1 className="font-[family-name:var(--font-sora)] text-[20px]">Result icons</h1>
        <button
          type="button"
          onClick={() => setRuns((r) => ({ success: r.success + 1, failed: r.failed + 1 }))}
          // Inline border: globals.css's unlayered button reset beats border-* utilities.
          style={{ border: "1px solid rgba(255,255,255,0.4)" }}
          className="rounded-full px-[18px] py-[8px] font-[family-name:var(--font-sora)] text-[14px] hover:[background-color:rgba(255,255,255,0.06)]"
        >
          Replay both
        </button>
      </header>
      <div className="grid grid-cols-2 gap-[24px] max-[900px]:grid-cols-1">
        <ResultCard
          key={`success-${runs.success}`}
          compact
          kind="success"
          title="Done! ₦2,043 is on its way"
          body="Sent to OPay •••• 207. It usually lands within minutes."
          actionLabel="Replay"
          onAction={() => replay("success")}
        />
        <ResultCard
          key={`failed-${runs.failed}`}
          compact
          kind="failed"
          title="Oops! Transaction failed"
          body="The transaction was cancelled during the initiating process"
          actionLabel="Replay"
          onAction={() => replay("failed")}
        />
      </div>
    </main>
  );
}
