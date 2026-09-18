import Image from "next/image";

const STATS = [
  { value: "₦480M+", caption: "Settled to Nigerian banks" },
  { value: "6,200+", caption: "Transfer completed" },
  { value: "< 90 sec", caption: "Typical time to payout" },
];

const LOGOS = [
  "/landing/chain-logo-1-stellar.png",
  "/landing/chain-logo-2-eth.png",
  "/landing/chain-logo-3-base.png",
  "/landing/chain-logo-4-arbitrum.png",
  "/landing/chain-logo-5-optimism.png",
  "/landing/chain-logo-6-solana.png",
  "/landing/chain-logo-7-polygon.png",
];

export function StatsStrip() {
  return (
    <section className="relative overflow-hidden bg-[#121212] px-[100px] py-[100px] max-[1100px]:px-[24px]">
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
        <div className="flex flex-wrap items-start justify-center gap-x-[136px] gap-y-[40px]">
          {STATS.map((stat) => (
            <div key={stat.caption} className="flex w-[219px] flex-col items-center gap-[9px] text-center">
              <span className="landing-fraunces text-[50px] text-white">{stat.value}</span>
              <span className="font-[family-name:var(--font-sora)] text-[18px] text-[#d0cccc]">
                {stat.caption}
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-[59px]">
          {LOGOS.map((src, i) => {
            const hasBackdrop = i > 0 && i < LOGOS.length - 1;
            return (
              <div
                key={src}
                className={`flex size-[56px] items-center justify-center rounded-full ${hasBackdrop ? "bg-[#f3f3f3]" : ""}`}
              >
                <Image src={src} alt="" width={30} height={30} className="size-[30px]" />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
