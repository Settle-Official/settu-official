import type { PlatformStats } from "@/components/RightPanel";

export interface PlatformStatsCardProps {
  readonly stats?: PlatformStats | null;
}

/**
 * The "PLATFORM STATS" block, extracted so it can render in both the offramp
 * RightPanel and the onramp tab without dragging along offramp-only payout copy.
 */
export function PlatformStatsCard({ stats }: Readonly<PlatformStatsCardProps>) {
  return (
    <section className="border border-[var(--line)] bg-[var(--bg)] p-4">
      <h3 className="mt-0 mb-[0.65rem] font-bold font-space-grotesk text-[1.13rem]">
        PLATFORM STATS
      </h3>
      <div className="flex items-center justify-between py-[0.35rem] text-[0.72rem] text-[var(--muted)]">
        <span>Total Users</span>
        <span className="font-space-grotesk text-[var(--foreground)] text-[1.1rem] font-bold">
          {stats ? stats.totalUsers.toLocaleString() : "--"}
        </span>
      </div>
      <div className="my-[0.45rem] h-px bg-[var(--line)]" />
      <div className="flex items-center justify-between py-[0.35rem] text-[0.72rem] text-[var(--muted)]">
        <span>Total Txn Vol</span>
        <span className="font-space-grotesk text-[var(--accent)] text-[1.5rem] font-bold">
          {stats
            ? `$${stats.totalVolume.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : "--"}
        </span>
      </div>
    </section>
  );
}
