import Image from "next/image";
import { StepCard } from "./StepCard";

export function HowItWorks() {
  return (
    <section id="how-it-works" className="px-[100px] py-[100px] max-[1100px]:px-[24px]">
      <div className="mx-auto flex w-[636px] max-w-full flex-col gap-[20px] pb-[100px] text-center">
        <div className="flex items-center justify-center gap-[10px]">
          <span className="h-[13px] w-[28px] rounded-[10px] border border-[#484747]" />
          <h2 className="landing-fraunces text-[30px] text-white">
            How $ettu actually moves your money
          </h2>
        </div>
        <p className="font-[family-name:var(--font-sora)] text-[16px] text-[#a9a5a5]">
          Three steps, and we tell you where things stand at each one, not just at the end.
        </p>
      </div>
      <div className="mx-auto flex w-[1240px] max-w-full flex-wrap justify-center gap-[77px]">
        <StepCard
          icon="/landing/step1-caption-wallet-icon.svg"
          iconAlt=""
          title="Connect wallet"
          description="Any EVM wallet or a Stellar wallet works. If you're not on Stellar, we bridge your USDC there automatically, you don't manage that step yourself."
        >
          <div className="flex flex-col gap-[18px]">
            <div className="flex items-center gap-[18px] rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[10px]">
              <Image
                src="/landing/chain-logo-1-stellar.png"
                alt=""
                width={56}
                height={56}
                className="rounded-full"
              />
              <div className="flex flex-col">
                <span className="landing-fraunces text-[20px] text-white">Stellar</span>
                <span className="font-[family-name:var(--font-sora)] text-[16px] text-white">wallet</span>
              </div>
              <span className="ml-auto font-[family-name:var(--font-inter)] text-[20px] font-semibold text-white">
                connect
              </span>
            </div>
            <div className="flex items-center gap-[18px] rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[10px]">
              <Image
                src="/landing/step1-metamask-icon.png"
                alt=""
                width={56}
                height={56}
                className="rounded-full"
              />
              <div className="flex flex-col">
                <span className="landing-fraunces text-[20px] text-white">Metamask</span>
                <span className="font-[family-name:var(--font-sora)] text-[16px] text-white">wallet</span>
              </div>
              <span className="ml-auto font-[family-name:var(--font-inter)] text-[20px] font-semibold text-white">
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
          <div className="flex items-center justify-between rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[10px]">
            <div className="flex items-center gap-[10px]">
              <Image src="/landing/step2-fx-lock-icon.svg" alt="" width={33} height={33} />
              <span className="landing-fraunces text-[20px] text-white">FX lock</span>
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
          description={'You’ll see each stage, bridging, locking, sending, in plain language, and a clear "done" the moment it’s in your account.'}
        >
          <div className="flex flex-col gap-[12px]">
            <div className="flex items-center justify-between rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[10px]">
              <span className="font-[family-name:var(--font-sora)] text-[16px] text-white">
                Payout currency
              </span>
              <span className="text-white">⌄</span>
            </div>
            <div className="flex gap-[10px]">
              <div className="flex-1 rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[10px] text-center font-[family-name:var(--font-sora)] text-[16px] text-white">
                account number
              </div>
              <div className="flex-1 rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[10px] text-center font-[family-name:var(--font-sora)] text-[16px] text-white">
                Bank
              </div>
            </div>
            <div className="rounded-[20px] border border-white/10 bg-[rgba(255,255,255,0.1)] p-[10px] font-[family-name:var(--font-sora)] text-[14px] text-white">
              Sent to GTBank •••• 6789. It usually lands within minutes.
            </div>
          </div>
        </StepCard>
      </div>
    </section>
  );
}
