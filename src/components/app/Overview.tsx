"use client";

import Link from "next/link";
import { useMemo, useState, type CSSProperties } from "react";
import { useActiveWallet } from "./ActiveWallet";
import { useWalletHistory, type HistoryRow } from "./useWalletHistory";
import {
  ArrowsUpDownIcon,
  CaretRightIcon,
  ChatIcon,
  CurrencyIcon,
  MoneyIcon,
} from "./icons";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const usd = (n: number) =>
  "$" + n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 2 });

const QUICK_ACTIONS = [
  {
    href: "/app/agent",
    title: "Withdraw with agent",
    body: "Use our AI to withdraw directly into your bank acc",
    icon: ChatIcon,
  },
  {
    href: "/app/offramp",
    title: "Offramp",
    body: "Withdraw manually entering your deatils",
    icon: MoneyIcon,
  },
  {
    href: "/app/onramp",
    title: "Onramp",
    body: "Buy your USDC in less than 2 sec",
    icon: CurrencyIcon,
  },
];

export function Overview() {
  const { active } = useActiveWallet();
  const address = active.isConnected ? active.address : undefined;
  // Server record (every device) merged with this browser's own rows.
  const { rows } = useWalletHistory(address);

  const stats = useMemo(() => {
    const settled = rows.filter((row) => row.status !== "failed");
    const sum = (pick: (row: HistoryRow) => boolean) =>
      settled.filter(pick).reduce((acc, row) => acc + row.usdc, 0);
    return {
      total: sum(() => true),
      offramp: sum((row) => row.kind === "offramp"),
      onramp: sum((row) => row.kind === "onramp"),
      agent: sum((row) => row.initiator === "agent"),
    };
  }, [rows]);

  // Monthly USDC volume for the current calendar year.
  const monthly = useMemo(() => {
    const year = new Date().getFullYear();
    const buckets = new Array<number>(12).fill(0);
    for (const row of rows) {
      if (row.status === "failed") continue;
      const d = new Date(row.timestamp);
      if (d.getFullYear() === year) buckets[d.getMonth()] += row.usdc;
    }
    return buckets;
  }, [rows]);

  const tiles = [
    // `phoneOnly: false` tiles are dropped on a phone: the mobile design
    // shows only Offramp and Onramp side by side, and four stacked tiles
    // pushed Quick Action entirely below the fold.
    { label: "Total transaction", value: stats.total, icon: ArrowsUpDownIcon, onPhone: false },
    { label: "Offramp", value: stats.offramp, icon: MoneyIcon, onPhone: true },
    { label: "Onramp", value: stats.onramp, icon: CurrencyIcon, onPhone: true },
    { label: "Withdraw by agent", value: stats.agent, icon: ChatIcon, onPhone: false },
  ];

  return (
    <>
      {/* Figma's tile frame says gap 40, but four 244px tiles only fit the
          1033px row at 20px — which is what its rendered screenshot shows. */}
      <div className="grid grid-cols-4 gap-[20px] max-[1100px]:grid-cols-2 max-[720px]:grid-cols-2 max-[720px]:gap-[10px]">
        {tiles.map(({ label, value, icon: TileIcon, onPhone }) => (
          <div
            key={label}
            style={{ "--glass-tint": "rgba(127,125,125,0.1)" } as CSSProperties}
            className={`liquid-glass relative flex min-h-[110px] flex-col justify-center gap-[10px] rounded-[20px] p-[20px] max-[720px]:px-[10px] max-[720px]:py-[20px] ${
              onPhone ? "" : "max-[720px]:hidden"
            }`}
          >
            <div className="flex items-center justify-between gap-[10px]">
              <span className="font-fraunces whitespace-nowrap text-[14px] font-semibold uppercase leading-[17px] text-[#d5d1d1] max-[720px]:whitespace-normal">
                {label}
              </span>
              <TileIcon size={22} className="shrink-0 text-[#f4f3f3]" />
            </div>
            <span className="font-[family-name:var(--font-inter)] text-[30px] font-medium leading-[36px] text-white">
              {usd(value)}
            </span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-[minmax(0,444fr)_minmax(0,545fr)] gap-[44px] max-[1400px]:gap-[20px] max-[1100px]:grid-cols-1">
        <section style={{ "--glass-tint": "rgba(255,255,255,0.1)" } as CSSProperties} className="liquid-glass relative flex flex-col gap-[24px] rounded-[30px] px-[20px] py-[30px] max-[720px]:gap-[30px]">
          <h2 className="border-b-[0.6px] border-[#484646] pb-[20px] font-fraunces text-[28px] leading-[35px] text-[#f4f0f0]">
            Quick Action
          </h2>
          <div className="flex flex-col gap-[24px]">
            {QUICK_ACTIONS.map(({ href, title, body, icon: ActionIcon }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-[12px] rounded-[20px] bg-[rgba(195,164,95,0.2)] p-[20px] transition-colors hover:bg-[rgba(195,164,95,0.32)] max-[720px]:min-h-[100px]"
              >
                <ActionIcon size={26} className="shrink-0 text-[#fbf9f9]" />
                <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
                  <span className="font-fraunces text-[20px] leading-[25px] text-white max-[720px]:text-[16px] max-[720px]:leading-[20px]">{title}</span>
                  <span className="font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-[#dcd6d6] max-[720px]:text-[12px] max-[720px]:leading-[15px]">
                    {body}
                  </span>
                </span>
                <CaretRightIcon size={24} className="shrink-0 text-[#fafafa]" />
              </Link>
            ))}
          </div>
        </section>

        <section style={{ "--glass-tint": "rgba(255,255,255,0.1)" } as CSSProperties} className="liquid-glass relative flex flex-col gap-[26px] rounded-[30px] px-[20px] py-[30px]">
          <div className="flex flex-col gap-[10px] border-b-[0.6px] border-[#484646] pb-[10px]">
            <h2 className="font-fraunces text-[28px] font-semibold leading-[35px] text-[#f4f0f0]">
              Transaction activity
            </h2>
            <p className="font-[family-name:var(--font-sora)] text-[14px] leading-[18px] text-[#bab6b6]">
              Monthly volume across your account
            </p>
          </div>
          <ActivityChart monthly={monthly} />
        </section>
      </div>
    </>
  );
}

/** Y axis: five even steps up to a "nice" ceiling above the busiest month. */
function niceCeiling(max: number) {
  if (max <= 0) return 1000;
  const pow = 10 ** Math.floor(Math.log10(max));
  const unit = max / pow;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return nice * pow;
}

function ActivityChart({ monthly }: { readonly monthly: ReadonlyArray<number> }) {
  const W = 394;
  const H = 250;
  const ceiling = niceCeiling(Math.max(...monthly));
  const steps = 5;
  const ticks = Array.from({ length: steps + 1 }, (_, i) => (ceiling * (steps - i)) / steps);
  const x = (i: number) => (i / 11) * W;
  const y = (v: number) => H - (v / ceiling) * H;
  const points = monthly.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const fmt = (v: number) => "$" + (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : v.toFixed(0));
  const [hover, setHover] = useState<number | null>(null);

  return (
    <div className="flex gap-[19px] max-[720px]:gap-[10px]">
      <div className="flex w-[62px] shrink-0 flex-col justify-between py-[2px] text-right max-[720px]:w-[44px]">
        {ticks.map((t, i) => (
          <span
            key={i}
            className="font-[family-name:var(--font-inter)] text-[14px] leading-[17px] text-white max-[720px]:text-[12px] max-[720px]:leading-[15px]"
          >
            {fmt(t)}
          </span>
        ))}
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col gap-[16px]">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-auto w-full overflow-visible max-[720px]:h-[230px]"
          aria-label="Monthly transaction volume"
        >
          {ticks.map((t, i) => (
            <line
              key={i}
              x1={0}
              x2={W}
              y1={y(t)}
              y2={y(t)}
              stroke="#4d4c4c"
              strokeWidth={0.6}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hover !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={0}
              y2={H}
              stroke="#c9a962"
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <polyline
            points={points}
            fill="none"
            stroke="#edeaea"
            strokeWidth={1.2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {hover !== null && (
            <circle
              cx={x(hover)}
              cy={y(monthly[hover])}
              r={4}
              fill="#c9a962"
              stroke="#1a1a1a"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {/* Generous invisible hit targets — the visible dots are tiny,
              this is what actually catches the pointer. */}
          {monthly.map((v, i) => (
            <rect
              key={i}
              x={Math.max(0, x(i) - W / 24)}
              y={0}
              width={W / 12}
              height={H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            />
          ))}
        </svg>

        {hover !== null && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-[10px] border border-white/10 bg-[#2b2a2a] px-[12px] py-[8px] shadow-[0_8px_20px_rgba(0,0,0,0.4)]"
            style={{
              left: `${(x(hover) / W) * 100}%`,
              top: `${Math.max(0, (y(monthly[hover]) / H) * 100 - 18)}%`,
            }}
          >
            <div className="font-[family-name:var(--font-inter)] text-[13px] font-semibold text-[#c9a962]">
              {usd(monthly[hover])}
            </div>
            <div className="font-[family-name:var(--font-sora)] text-[11px] text-[#bab6b6]">
              {MONTHS[hover]}
            </div>
          </div>
        )}

        <div className="flex justify-between font-[family-name:var(--font-inter)] text-[14px] leading-[17px] text-white max-[720px]:text-[12px] max-[720px]:leading-[15px]">
          {MONTHS.filter((_, i) => i % 2 === 0).map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
