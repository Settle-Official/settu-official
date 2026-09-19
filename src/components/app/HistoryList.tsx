"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStellarWallet } from "@/hooks/useStellarWallet";
import { fiatSymbol } from "@/lib/format/currency";
import { FunnelIcon, SearchIcon } from "./icons";
import { useWalletHistory, type HistoryRow } from "./useWalletHistory";

const STATUS_LABEL: Record<HistoryRow["status"], string> = {
  pending: "Pending",
  completed: "Completed",
  failed: "Failed",
};

const STATUS_COLOR: Record<HistoryRow["status"], string> = {
  pending: "#AE9611",
  completed: "#109F21",
  failed: "#CA4C4C",
};

// The six columns, sized in the design's proportions rather than its exact
// pixels: at 148+120+124+188+133+133 plus five 54px gaps the row comes to
// 1116px, which is wider than the content panel actually is, so fixed widths
// pushed Date off the edge. As fractions they keep the same relative sizing
// and still fill whatever width there is.
// Nudged from the design's exact ratios to fit real content: "USDC" needs
// less room than "Coin Type" suggests, while a full date ("19 Sept 2026")
// needs more than 133 gives it.
const COLUMNS = [
  { key: "coin", label: "Coin Type", fr: 125 },
  { key: "worth", label: "Worth", fr: 110 },
  { key: "rate", label: "Rate", fr: 140 },
  { key: "received", label: "Amount Received", fr: 180 },
  { key: "status", label: "Status", fr: 128 },
  { key: "date", label: "Date", fr: 155 },
] as const;

const GRID = {
  display: "grid",
  gridTemplateColumns: COLUMNS.map((c) => `${c.fr}fr`).join(" "),
  gap: "clamp(12px, 2.2vw, 54px)",
  borderBottom: "1px solid #262424",
};

type StatusFilter = "all" | HistoryRow["status"];

const FILTERS: readonly { readonly value: StatusFilter; readonly label: string }[] = [
  { value: "all", label: "All transactions" },
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const fmtDate = (ts: number) =>
  new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const fmtUsdc = (n: number) => (n > 0 ? n.toFixed(2) : "—");

function fmtAmount(row: HistoryRow) {
  const n = Number(row.fiatAmount);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `${fiatSymbol(row.currency)}${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** No rate is stored anywhere, so derive it from the two amounts we do have. */
function fmtRate(row: HistoryRow) {
  const fiat = Number(row.fiatAmount);
  if (!Number.isFinite(fiat) || fiat <= 0 || row.usdc <= 0) return "—";
  const rate = Math.round(fiat / row.usdc);
  return `${fiatSymbol(row.currency)}${rate.toLocaleString("en-US")}/USD`;
}

function matches(row: HistoryRow, q: string) {
  return [
    "usdc",
    row.kind,
    row.initiator ?? "",
    row.sourceChain ?? "",
    String(row.usdc),
    row.fiatAmount ?? "",
    row.currency,
    STATUS_LABEL[row.status],
    row.txHash ?? "",
    row.orderId ?? "",
    row.accountName ?? "",
    row.bank ?? "",
    row.accountNumber ?? "",
    fmtDate(row.timestamp),
  ]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

function Cell({ children, color }: { readonly children: React.ReactNode; readonly color?: string }) {
  return (
    <div style={{ color }} className="flex min-w-0 items-center p-[10px] max-[900px]:p-[4px]">
      <span className="truncate font-[family-name:var(--font-sora)] text-[18px] leading-[23px] max-[1300px]:text-[16px] max-[900px]:text-[14px]">
        {children}
      </span>
    </div>
  );
}

export function HistoryList({ notificationsView = false }: { readonly notificationsView?: boolean }) {
  const { wallet } = useStellarWallet();
  const router = useRouter();
  const params = useSearchParams();
  const { rows, isLoading } = useWalletHistory(wallet?.publicKey);

  // The top bar's search pushes here as `?q=`, so the field is seeded from
  // the URL and keeps writing back to it — one search, two entry points.
  const urlQuery = params.get("q") ?? "";
  const [query, setQuery] = useState(urlQuery);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => setQuery(urlQuery), [urlQuery]);

  useEffect(() => {
    if (query === urlQuery) return;
    const id = setTimeout(() => {
      router.replace(query ? `/app/history?q=${encodeURIComponent(query)}` : "/app/history", {
        scroll: false,
      });
    }, 300);
    return () => clearTimeout(id);
  }, [query, urlQuery, router]);

  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!filterRef.current?.contains(e.target as Node)) setFilterOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [filterOpen]);

  const q = query.trim().toLowerCase();
  // useWalletHistory already returns newest-first.
  const visible = useMemo(
    () =>
      rows.filter(
        (row) => (status === "all" || row.status === status) && (!q || matches(row, q)),
      ),
    [rows, q, status],
  );

  const empty = !wallet?.publicKey
    ? "Connect your wallet to see its transactions."
    : isLoading && rows.length === 0
      ? "Loading your transactions…"
      : q || status !== "all"
        ? "Nothing matches that search."
        : "No transactions yet.";

  return (
    <div className="flex min-w-0 flex-col gap-[26px]">
      {notificationsView && (
        <h2 className="font-fraunces text-[28px] leading-[35px] text-[#f4f0f0]">Recent activity</h2>
      )}

      {!notificationsView && (
        <div className="flex flex-wrap items-center gap-[26px] max-[900px]:gap-[12px]">
          <label
            style={{ border: "1px solid #D7D6D6" }}
            className="flex h-[70px] w-[450px] items-center gap-[6px] rounded-[20px] p-[20px] max-[900px]:h-[56px] max-[900px]:w-full"
          >
            <SearchIcon size={18} className="shrink-0 text-[#a5a2a2]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search coin type, status etc"
              aria-label="Search transactions"
              className="min-w-0 flex-1 bg-transparent font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-white outline-none placeholder:text-[#8d8c8c]"
            />
          </label>

          <div ref={filterRef} className="relative">
            {/* Inline border: globals.css has an unlayered
                `button { background: none; border: 0 }` reset that beats
                Tailwind's border and background utilities here. */}
            <button
              type="button"
              onClick={() => setFilterOpen((o) => !o)}
              aria-expanded={filterOpen}
              aria-haspopup="listbox"
              style={{ border: "1px solid #D7D6D6" }}
              className="flex h-[70px] min-w-[125px] items-center gap-[6px] rounded-[20px] p-[20px] font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-[#8d8c8c] max-[900px]:h-[56px]"
            >
              <FunnelIcon size={18} className="shrink-0 text-[#a5a2a2]" />
              {status === "all" ? "Filter" : STATUS_LABEL[status]}
            </button>
            {filterOpen && (
              <ul
                role="listbox"
                className="absolute left-0 top-[78px] z-20 flex w-[200px] flex-col overflow-hidden rounded-[16px] border border-white/15 bg-[#242323] py-[6px] shadow-[0_18px_36px_rgba(0,0,0,0.5)]"
              >
                {FILTERS.map((option) => (
                  <li key={option.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={status === option.value}
                      onClick={() => {
                        setStatus(option.value);
                        setFilterOpen(false);
                      }}
                      style={{
                        backgroundColor: status === option.value ? "rgba(201,169,98,0.18)" : "transparent",
                      }}
                      className="flex w-full items-center px-[18px] py-[12px] text-left font-[family-name:var(--font-sora)] text-[15px] text-white transition-colors hover:brightness-125"
                    >
                      {option.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="py-[28px] font-[family-name:var(--font-sora)] text-[16px] text-[#bab6b6]">
          {empty}
        </p>
      ) : (
        <>
          {/* Wide: the six-column table. */}
          <div className="flex min-w-0 flex-col max-[900px]:hidden">
            <div style={GRID} className="items-center pb-[20px]">
              {COLUMNS.map((column) => (
                <Cell key={column.key} color="#A19D9D">
                  {column.label}
                </Cell>
              ))}
            </div>
            <div className="flex flex-col gap-[10px]">
              {visible.map((row) => (
                <div key={row.id} style={GRID} className="items-center pb-[20px]">
                  <Cell color="#FFFFFF">USDC</Cell>
                  <Cell color="#FFFFFF">{fmtUsdc(row.usdc)}</Cell>
                  <Cell color="#FFFFFF">{fmtRate(row)}</Cell>
                  <Cell color="#FFFFFF">{fmtAmount(row)}</Cell>
                  <Cell color={STATUS_COLOR[row.status]}>{STATUS_LABEL[row.status]}</Cell>
                  <Cell color="#FFFFFF">{fmtDate(row.timestamp)}</Cell>
                </div>
              ))}
            </div>
          </div>

          {/* Narrow: six columns can't stay legible, so each transaction
              becomes a stacked card carrying the same six fields. */}
          <ul className="hidden flex-col gap-[12px] max-[900px]:flex">
            {visible.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-[10px] rounded-[20px] bg-[rgba(127,125,125,0.1)] p-[18px]"
              >
                <div className="flex items-baseline justify-between gap-[10px]">
                  <span className="font-[family-name:var(--font-sora)] text-[17px] text-white">
                    {fmtUsdc(row.usdc)} USDC
                  </span>
                  <span
                    style={{ color: STATUS_COLOR[row.status] }}
                    className="font-[family-name:var(--font-sora)] text-[15px]"
                  >
                    {STATUS_LABEL[row.status]}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-[10px]">
                  <span className="font-[family-name:var(--font-sora)] text-[15px] text-[#d6d3d3]">
                    {fmtAmount(row)}
                  </span>
                  <span className="font-[family-name:var(--font-sora)] text-[13px] text-[#a19d9d]">
                    {fmtRate(row)}
                  </span>
                </div>
                <span className="font-[family-name:var(--font-sora)] text-[13px] text-[#a19d9d]">
                  {fmtDate(row.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
