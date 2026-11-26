import Image from "next/image";
import { formatRate, getMarketRates, type MarketRate } from "@/lib/stats/market-rates";

function Item({ m }: { m: MarketRate }) {
  return (
    <div className="flex shrink-0 items-center gap-[14px] rounded-[40px] border border-white/10 bg-[#1b1a1a] py-[10px] pl-[10px] pr-[22px] max-[720px]:gap-[10px] max-[720px]:pr-[16px]">
      <Image
        src={`/landing/flags/${m.flag}.svg`}
        alt=""
        width={36}
        height={36}
        className="size-[36px] rounded-full object-cover ring-1 ring-white/15 max-[720px]:size-[30px]"
      />
      <div className="flex flex-col leading-tight">
        <span className="font-[family-name:var(--font-sora)] text-[15px] text-white max-[720px]:text-[13px]">{m.country}</span>
        <span className="font-[family-name:var(--font-sora)] text-[12px] tracking-[0.12em] text-[#8f8b8b]">{m.code}</span>
      </div>
      <span className="landing-fraunces ml-[6px] text-[22px] text-[#c9a962] max-[720px]:text-[18px]">
        {m.rate === null ? <span className="text-[16px] text-[#8f8b8b]">Coming soon</span> : formatRate(m, m.rate)}
      </span>
    </div>
  );
}

/**
 * "Live in 7 markets": every country Settu pays out to, with today's best
 * USDC rate, on the landing marquee (same loop technique as the networks
 * strip, run in reverse so the two read as counter-motion).
 */
export async function MarketsTicker() {
  const rates = await getMarketRates();
  return (
    <section aria-labelledby="markets-heading" className="relative bg-[#121212] px-[100px] pb-[90px] max-[720px]:px-[20px] max-[720px]:pt-[56px] max-[720px]:pb-[50px]">
      <div className="mx-auto flex w-[1240px] max-w-full flex-col items-center gap-[28px]">
        <div className="flex flex-col items-center gap-[10px] text-center">
          <h2 id="markets-heading" className="landing-fraunces text-[40px] text-white max-[720px]:text-[32px] max-[720px]:leading-[1.15]">
            Live in {rates.length} African
            <span className="max-[720px]:block"> markets</span>
          </h2>
          <p className="font-[family-name:var(--font-sora)] text-[16px] text-[#a9a4a4] max-[720px]:text-[14px]">
            Here&rsquo;s what 1 USDC gets you today.
          </p>
        </div>

        {/* Screen readers get the plain list; the moving copy is decorative. */}
        <ul className="sr-only">
          {rates.map((m) => (
            <li key={m.code}>{m.country} ({m.code}): {m.rate === null ? "rate updating" : `${formatRate(m, m.rate)} per USDC`}</li>
          ))}
        </ul>
        <div aria-hidden="true" className="landing-marquee-fade w-full overflow-hidden">
          <div className="landing-marquee-track landing-marquee-reverse gap-[16px]">
            {[...rates, ...rates, ...rates, ...rates].map((m, i) => <Item key={`${m.code}-${i}`} m={m} />)}
          </div>
        </div>
        <p className="font-[family-name:var(--font-sora)] text-[13px] text-[#8f8b8b]">
          Rates refresh every few minutes. You&rsquo;ll see your exact rate and fees before you confirm.
        </p>
      </div>
    </section>
  );
}
