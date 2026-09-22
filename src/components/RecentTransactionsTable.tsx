"use client";

import { useEffect, useState } from "react";
import type { RecentTransactionRow } from "@/types/stellaramp";
import { cn } from "@/lib/cn";

const PAGE_SIZE = 10;

export interface RecentTransactionsTableProps {
  readonly rows: ReadonlyArray<RecentTransactionRow>;
  readonly isLive?: boolean;
}

export function RecentTransactionsTable({
  rows,
  isLive,
}: Readonly<RecentTransactionsTableProps>) {
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const [page, setPage] = useState(1);

  // Rows refresh on a live interval, so clamp rather than reset — stay put
  // unless the current page no longer exists (e.g. the list just shrank).
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <section className="border border-[var(--line)] bg-[var(--bg)] p-[0.8rem]">
      <div className="mb-[0.65rem] flex items-end justify-between">
        <h2 className="m-0 font-space-grotesk font-bold text-[1.50rem]">
          RECENT TRANSACTIONS
        </h2>
        {isLive && (
          <span className="flex items-center gap-1.5 text-[0.62rem] tracking-[0.06em] text-[var(--accent)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] [animation:pulse_1.2s_ease-in-out_infinite]" />
            LIVE
          </span>
        )}
      </div>
      <table className="w-full border-collapse text-[0.72rem] max-[720px]:block max-[720px]:overflow-x-auto">
        <thead>
          <tr>
            <th className="bg-[var(--accent)] p-[0.55rem] font-semibold font-space-grotesk text-left text-[0.7rem] text-[var(--accent-contrast)]">
              TYPE
            </th>
            <th className="bg-[var(--accent)] p-[0.55rem] font-semibold font-space-grotesk text-left text-[0.7rem] text-[var(--accent-contrast)]">
              TX HASH
            </th>
            <th className="bg-[var(--accent)] p-[0.55rem] font-semibold font-space-grotesk text-left text-[0.7rem] text-[var(--accent-contrast)]">
              USDC
            </th>
            <th className="bg-[var(--accent)] p-[0.55rem] font-semibold font-space-grotesk text-left text-[0.7rem] text-[var(--accent-contrast)]">
              NAIRA
            </th>
            <th className="bg-[var(--accent)] p-[0.55rem] font-semibold font-space-grotesk text-left text-[0.7rem] text-[var(--accent-contrast)]">
              STATUS
            </th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row, index) => (
            <tr key={`${row.txHash}-${index}`}>
              <td className="border-t border-t-[var(--line)] p-[0.68rem_0.55rem]">
                <span
                  className={cn(
                    "inline-block border px-[0.55rem] py-[0.2rem] text-[0.6rem]",
                    row.type === "onramp"
                      ? "border-[var(--accent)] text-[var(--accent)]"
                      : "border-[var(--foreground)] text-[var(--foreground)]",
                  )}
                >
                  {row.type === "onramp" ? "ONRAMP" : "OFFRAMP"}
                </span>
              </td>
              <td className="border-t border-t-[var(--line)] font-space-grotesk p-[0.68rem_0.55rem]">
                {row.txHash}
              </td>
              <td className="border-t border-t-[var(--line)] font-space-grotesk p-[0.68rem_0.55rem]">
                {row.usdc}
              </td>
              <td className="border-t border-t-[var(--line)] font-space-grotesk p-[0.68rem_0.55rem]">
                {row.naira}
              </td>
              <td className="border-t border-t-[var(--line)] p-[0.68rem_0.55rem]">
                <span
                  className={
                    row.status === "SETTLING"
                      ? "inline-block border border-[var(--accent)] bg-[var(--accent)] px-[0.55rem] py-[0.2rem] text-[0.6rem] text-[var(--accent-contrast)]"
                      : "inline-block border border-[var(--foreground)] px-[0.55rem] py-[0.2rem] text-[0.6rem]"
                  }
                >
                  {row.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-[0.7rem] flex items-center justify-between text-[0.68rem] text-[var(--muted)]">
        <button
          type="button"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={page === 1}
          className="border border-[var(--line)] px-[0.6rem] py-[0.3rem] uppercase tracking-[0.06em] text-[var(--accent)] hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--line)]"
        >
          Prev
        </button>
        <span>
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
          disabled={page === pageCount}
          className="border border-[var(--line)] px-[0.6rem] py-[0.3rem] uppercase tracking-[0.06em] text-[var(--accent)] hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--line)]"
        >
          Next
        </button>
      </div>
    </section>
  );
}
