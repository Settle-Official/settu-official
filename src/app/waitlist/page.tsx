import type { Metadata } from "next";
import { Fraunces, Sora } from "next/font/google";
import { SettuLogo } from "@/components/brand/SettuLogo";
import { WaitlistForm } from "@/components/waitlist/WaitlistForm";
import "@/components/landing/landing.css";

export const metadata: Metadata = {
  title: "Settu API — Join the waitlist",
  description: "Offramp and onramp APIs for stablecoins across Africa. Join the waitlist for early access.",
};

const fraunces = Fraunces({ subsets: ["latin"], axes: ["SOFT", "WONK"], variable: "--font-fraunces", display: "swap" });
const sora = Sora({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-sora", display: "swap" });

const POINTS = [
  ["Offramp & onramp", "Stablecoins to local currency and back, through one API."],
  ["7 African markets", "Nigeria, Ghana, Kenya, Tanzania, Rwanda, Uganda and Zambia."],
  ["Bank & mobile money", "Payouts land in bank accounts and mobile wallets, usually within minutes."],
  ["8 chains", "Accept USDC from Stellar, Solana and major EVM networks."],
] as const;

export default function WaitlistPage() {
  return (
    <main className={`${fraunces.variable} ${sora.variable} min-h-screen bg-[#121212] text-white font-[family-name:var(--font-sora)]`}>
      <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 h-[520px]" style={{ background: "radial-gradient(ellipse 70% 60% at 50% 0%, rgba(201,169,98,0.16), rgba(201,169,98,0) 70%)" }} />
      <header className="relative mx-auto flex w-[1180px] max-w-[calc(100%-40px)] items-center justify-between py-[28px]">
        <a href="/" aria-label="Settu home"><SettuLogo className="h-[26px] w-auto" /></a>
        <a href="/app" className="font-[family-name:var(--font-sora)] text-[15px] text-[#d0cccc] hover:text-[#c9a962]">Open the app</a>
      </header>

      <div className="relative mx-auto grid w-[1180px] max-w-[calc(100%-40px)] grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-[64px] pb-[100px] pt-[40px] max-[960px]:grid-cols-1 max-[960px]:gap-[40px] max-[720px]:pt-[10px]">
        <section className="flex flex-col gap-[28px]">
          <span className="font-[family-name:var(--font-sora)] text-[13px] font-semibold tracking-[0.22em] text-[#c9a962]">SETTU API · EARLY ACCESS</span>
          <h1 className="landing-fraunces text-[52px] uppercase leading-[1.05] text-[#c9a962] max-[720px]:text-[34px]">Build on Africa&rsquo;s stablecoin rails</h1>
          <p className="max-w-[480px] font-[family-name:var(--font-sora)] text-[18px] leading-[29px] text-[#d0cccc] max-[720px]:text-[16px] max-[720px]:leading-[26px]">
            The same infrastructure behind the Settu app, as an API. Let your users cash out stablecoins to local banks, or fund their wallets, without leaving your product.
          </p>
          <ul className="flex flex-col gap-[18px]">
            {POINTS.map(([title, body]) => (
              <li key={title} className="flex gap-[14px]">
                <span aria-hidden="true" className="mt-[7px] size-[9px] shrink-0 rounded-full bg-[#c9a962]" />
                <div className="flex flex-col gap-[3px]">
                  <span className="font-[family-name:var(--font-sora)] text-[16px] font-semibold text-white">{title}</span>
                  <span className="font-[family-name:var(--font-sora)] text-[15px] leading-[23px] text-[#a9a5a5]">{body}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="Join the waitlist">
          <WaitlistForm />
        </section>
      </div>
    </main>
  );
}
