import Image from "next/image";

export function Hero() {
  return (
    <section className="relative overflow-hidden px-[257px] pt-[59px] pb-[103px] max-[1100px]:px-[24px]">
      {/* Background layers */}
      <div className="pointer-events-none absolute inset-0">
        <Image src="/landing/hero-bg-grid.svg" alt="" fill className="object-cover opacity-40" />
        <Image
          src="/landing/hero-lightbeam-1.svg"
          alt=""
          width={243}
          height={378}
          className="absolute right-0 top-0 mix-blend-plus-lighter rotate-[18.49deg]"
        />
        <Image
          src="/landing/hero-lightbeam-2.svg"
          alt=""
          width={184}
          height={368}
          className="absolute right-[80px] top-0 mix-blend-plus-lighter rotate-[7.78deg]"
        />
        <Image
          src="/landing/hero-lightbeam-3.svg"
          alt=""
          width={148}
          height={356}
          className="absolute right-[160px] top-0 mix-blend-plus-lighter rotate-[1.71deg]"
        />
        <Image
          src="/landing/hero-glow-ellipse.svg"
          alt=""
          width={362}
          height={402}
          className="absolute right-0 top-0 rotate-[34.05deg]"
        />
        <Image
          src="/landing/hero-floating-dots.svg"
          alt=""
          width={302}
          height={230}
          className="absolute right-[40px] top-[47px]"
        />
        <Image
          src="/landing/hero-bottom-glow.svg"
          alt=""
          width={962}
          height={962}
          className="absolute bottom-[-500px] left-1/2 -translate-x-1/2"
        />
      </div>

      {/* Content */}
      <div className="relative mx-auto flex w-[765px] max-w-full flex-col items-center gap-[34px] pt-[112px] text-center">
        <Image
          src="/landing/hero-illustration.png"
          alt="Coins converting to a bank deposit"
          width={417}
          height={264}
          className="h-auto w-[417px] max-w-full"
          priority
        />
        <div className="flex flex-col items-center gap-[19px]">
          <h1 className="landing-fraunces text-[50px] uppercase leading-tight text-[#c9a962] max-[720px]:text-[32px]">
            Convert USDC to your bank account
          </h1>
          <p className="landing-fraunces text-[20px] leading-[26px] text-[#fdf8f8] max-[720px]:text-[16px]">
            Move USDC across chains and land it directly in your account. No
            P2P traders. No waiting. Just simple transfers.
          </p>
        </div>
        <a
          href="/app"
          className="rounded-[40px] bg-[rgba(201,169,98,0.6)] px-[16px] py-[16px] font-[family-name:var(--font-sora)] text-[16px] text-white transition-colors hover:bg-[rgba(201,169,98,0.8)]"
        >
          Convert USDC Now
        </a>
      </div>
    </section>
  );
}
