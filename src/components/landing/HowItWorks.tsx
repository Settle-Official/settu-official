import Image from "next/image";
import { HorizonGlow } from "./HorizonGlow";
import { StepCard } from "./StepCard";

export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="relative flex flex-col items-center gap-[125px] overflow-hidden bg-[#121212] p-[100px] max-[720px]:gap-[40px] max-[720px]:p-[20px]"
    >
      {/* Lifted above the card row so the row's glow, which reaches up
          behind this heading, stays underneath the text. */}
      <div className="relative z-[1] flex w-[636px] max-w-full flex-col items-center gap-[20px] text-center max-[720px]:w-[282px]">
        <div className="flex items-center gap-[10px] max-[720px]:flex-col max-[720px]:gap-[6px]">
          <span className="h-[13px] w-[28px] rounded-[10px] border border-[#484747]" />
          <h2 className="landing-fraunces text-[30px] text-white max-[720px]:text-[20px] max-[720px]:leading-[25px]">
            How $ettu actually moves your money
          </h2>
        </div>
        <p className="font-[family-name:var(--font-sora)] text-[16px] text-[#a9a5a5] max-[720px]:leading-[20px] max-[720px]:text-[#beb9b9]">
          Three steps, and we tell you where things stand at each one, not just
          at the end.
        </p>
      </div>

      <div className="relative flex w-[1240px] max-w-full flex-wrap justify-between gap-[40px] [isolation:isolate] max-[720px]:flex-col max-[720px]:items-center">
        {/* Dome glow behind the cards: its rim peaks just above the row and
            its sides run down behind the outer cards, showing through the
            card gaps and their translucent backgrounds. */}
        <HorizonGlow
          width={1240}
          height={520}
          rx={440}
          ry={440}
          apexY={140}
          blur={44}
          spread={28}
          opacity={0.5}
          fadeBottomFrom={400}
          fadeX={0.15}
          innerBlur={30}
          className="pointer-events-none absolute left-1/2 top-[-160px] z-0 max-w-none -translate-x-1/2 max-[720px]:hidden"
        />
        {/* Phone: the cards stack, and Figma places two smaller domes off the
            left edge behind cards 1–2 and off the right edge behind cards
            2–3, so a soft band of light crosses the stack diagonally. */}
        <HorizonGlow
          width={665}
          height={520}
          rx={300}
          ry={300}
          apexY={60}
          blur={50}
          spread={24}
          opacity={0.4}
          fadeBottomFrom={380}
          fadeX={0.1}
          innerBlur={50}
          className="pointer-events-none absolute left-[-303px] top-[382px] z-0 hidden max-w-none max-[720px]:block"
        />
        <HorizonGlow
          width={665}
          height={520}
          rx={300}
          ry={300}
          apexY={60}
          blur={50}
          spread={24}
          opacity={0.4}
          fadeBottomFrom={380}
          fadeX={0.1}
          innerBlur={50}
          className="pointer-events-none absolute left-[-26px] top-[918px] z-0 hidden max-w-none max-[720px]:block"
        />

        <StepCard
          icon="/landing/step1-caption-wallet-icon.svg"
          iconAlt=""
          title="Connect wallet"
          description="Any EVM wallet, Solana Wallet or a Stellar wallet works. If you're not on Stellar, we bridge your USDC there automatically, you don't manage that step yourself."
          align="center"
        >
          <div className="flex flex-col gap-[40px]">
            <div className="flex h-[76px] items-center gap-[18px] rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[10px] max-[720px]:h-[68px]">
              <Image
                src="/landing/chain-logo-1-stellar.png"
                alt=""
                width={56}
                height={56}
                className="rounded-full max-[720px]:size-[43px]"
              />
              <div className="flex flex-col gap-[6px]">
                <span className="landing-fraunces text-[20px] text-white max-[720px]:text-[18px] max-[720px]:leading-[22px]">
                  Stellar
                </span>
                <span className="font-[family-name:var(--font-sora)] text-[16px] text-white max-[720px]:leading-[20px]">
                  wallet
                </span>
              </div>
              <span className="ml-auto font-[family-name:var(--font-inter)] text-[20px] font-semibold text-white max-[720px]:text-[14px]">
                connect
              </span>
            </div>
            <div className="flex h-[76px] items-center gap-[18px] rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[10px] max-[720px]:h-[68px]">
              <div className="flex size-[56px] shrink-0 items-center justify-center rounded-full bg-white max-[720px]:size-[43px]">
                <Image
                  src="/landing/step1-metamask-icon.png"
                  alt=""
                  width={36}
                  height={36}
                  className="max-[720px]:size-[23px]"
                />
              </div>
              <div className="flex flex-col gap-[6px]">
                <span className="landing-fraunces text-[20px] text-white max-[720px]:text-[18px] max-[720px]:leading-[22px]">
                  Metamask
                </span>
                <span className="font-[family-name:var(--font-sora)] text-[16px] text-white max-[720px]:leading-[20px]">
                  wallet
                </span>
              </div>
              <span className="ml-auto font-[family-name:var(--font-inter)] text-[20px] font-semibold text-white max-[720px]:text-[14px]">
                connect
              </span>
            </div>
          </div>
        </StepCard>

        <StepCard
          icon="/landing/step2-fx-lock-icon.svg"
          iconAlt=""
          title="Your rate locks instantly"
          description="The Naira rate you're quoted is the rate you get, held for a short window while you confirm. No surprises at the last step."
        >
          <div className="flex h-[53px] items-center justify-between rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[10px]">
            <div className="flex items-center gap-[10px]">
              <Image
                src="/landing/step2-fx-lock-icon.svg"
                alt=""
                width={33}
                height={33}
              />
              <span className="landing-fraunces text-[20px] text-white">
                FX lock
              </span>
            </div>
            <span className="font-[family-name:var(--font-sora)] text-[14px] font-semibold text-white">
              1380/USDC
            </span>
          </div>
        </StepCard>

        <StepCard
          icon="/landing/step1-caption-wallet-icon.svg"
          iconAlt=""
          title="Naira lands in your bank"
          description={
            'You’ll see each stage, bridging, locking, sending, in plain language, and a clear "done" the moment it’s in your account.'
          }
        >
          <div className="flex flex-col gap-[20px]">
            <div className="flex h-[58px] items-center justify-between rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[20px]">
              <span className="font-[family-name:var(--font-inter)] text-[14px] text-white">
                Payout currency
              </span>
              <span className="text-white">⌄</span>
            </div>
            <div className="flex gap-[7px]">
              <div className="flex h-[57px] flex-1 items-center justify-center rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[20px]">
                <span className="font-[family-name:var(--font-inter)] text-[14px] text-white">
                  account number
                </span>
              </div>
              <div className="flex h-[57px] flex-1 items-center justify-center rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[20px]">
                <span className="font-[family-name:var(--font-inter)] text-[14px] text-white">
                  Bank
                </span>
              </div>
            </div>
            <div className="flex h-[54px] items-center rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[10px]">
              <span className="font-[family-name:var(--font-inter)] text-[14px] font-medium text-white">
                Sent to GTBank •••• 6789. It usually lands within minutes.
              </span>
            </div>
          </div>
        </StepCard>
      </div>
    </section>
  );
}
