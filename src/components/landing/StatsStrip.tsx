import Image from "next/image";
import { getLandingStats } from "@/lib/stats/landing-stats";

/** ₦16,926,377 -> "₦16.9M+". Rounded down, so the claim is never overstated. */
function compactNaira(amount: number): string {
  if (amount >= 1_000_000_000)
    return `₦${Math.floor(amount / 100_000_000) / 10}B+`;
  if (amount >= 1_000_000) return `₦${Math.floor(amount / 100_000) / 10}M+`;
  if (amount >= 1_000) return `₦${Math.floor(amount / 1_000)}K+`;
  return `₦${Math.floor(amount)}`;
}

function compactCount(n: number): string {
  return n >= 1000 ? `${Math.floor(n / 100) / 10}K+` : `${n}+`;
}

const LOGOS = [
  "/landing/chain-logo-1-stellar.png",
  "/landing/chain-logo-2-eth.png",
  "/landing/chain-logo-3-base.png",
  "/landing/chain-logo-4-arbitrum.png",
  "/landing/chain-logo-5-optimism.png",
  "/landing/chain-logo-6-solana.png",
  "/landing/chain-logo-7-polygon.png",
];

/**
 * Server component: the figures are read from the durable transaction
 * records (see lib/stats/landing-stats.ts), rather than hardcoded. They once
 * claimed ₦480M and 6,200 transfers, which the Paycrest export puts at
 * ₦16.9M and 296 — reading what actually settled is the only way that stays
 * honest. The page regenerates every 5 minutes (app/page.tsx).
 */
export async function StatsStrip() {
  const { settledNgn, transfers } = await getLandingStats();
  const STATS = [
    {
      value: compactNaira(settledNgn),
      caption: "Settled to Nigerian banks",
    },
    { value: compactCount(transfers), caption: "Transfers completed" },
    // Median across 295 settled orders in the export is 3.8 min. The old
    // "< 90 sec" was not survivable: only 1.4% of real payouts landed that
    // fast, while 65% land inside five minutes.
    { value: "~3 min", caption: "Typical time to payout" },
  ];

  return (
    <section className="relative overflow-hidden bg-[#121212] px-[100px] pb-[100px] pt-[165px] mt-[50px] max-[720px]:mt-0 max-[720px]:px-[20px] max-[720px]:pb-[40px] max-[720px]:pt-[110px]">
      <Image
        src="/landing/stats-glow-left.svg"
        alt=""
        width={370}
        height={186}
        className="pointer-events-none absolute left-[142px] top-[251px]"
      />
      <Image
        src="/landing/stats-glow-right.svg"
        alt=""
        width={370}
        height={186}
        className="pointer-events-none absolute right-[142px] top-[251px]"
      />
      <div className="relative mx-auto flex w-[1240px] max-w-full flex-col items-center gap-[50px]">
        <div className="flex flex-wrap items-start justify-center gap-x-[136px] gap-y-[40px] max-[720px]:flex-col max-[720px]:items-center max-[720px]:gap-y-[70px] max-[720px]:py-[40px]">
          {STATS.map((stat) => (
            <div
              key={stat.caption}
              className="flex w-[219px] flex-col items-center gap-[9px] text-center"
            >
              <span className="landing-fraunces text-[50px] text-white max-[720px]:text-[40px] max-[720px]:leading-[49px]">
                {stat.value}
              </span>
              <span className="font-[family-name:var(--font-sora)] text-[18px] text-[#d0cccc] max-[720px]:leading-[23px] max-[720px]:text-[#bbb9b9]">
                {stat.caption}
              </span>
            </div>
          ))}
        </div>
        <div className="landing-marquee-fade w-full overflow-hidden">
          <div className="landing-marquee-track gap-[59px] max-[720px]:gap-[40px]">
            {/* Four copies, not two — a single set (~750px) is narrower than
                the visible track, so doubling it still left a gap of empty
                space right before the loop reset. Four safely covers twice
                the widest realistic viewport, which is what the "translate
                by -50%" seamless-loop trick actually requires. */}
            {[...LOGOS, ...LOGOS, ...LOGOS, ...LOGOS].map((src, i) => (
              <div
                key={`${src}-${i}`}
                className="flex size-[56px] shrink-0 items-center justify-center rounded-full bg-[#f3f3f3]"
              >
                <Image
                  src={src}
                  alt=""
                  width={34}
                  height={34}
                  className="size-[34px] object-contain"
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
