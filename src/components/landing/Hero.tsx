import Image from "next/image";
import { HeroBeams } from "./HeroBeams";
import { HeroCoins } from "./HeroCoins";
import { HeroDots } from "./HeroDots";
import { HorizonGlow } from "./HorizonGlow";
import { Nav } from "./Nav";

export function Hero() {
  // Clip horizontally only (the grid asset overflows to the right) and stack
  // above the stats strip, so the horizon glow can run past the hero's bottom
  // edge without being cut or painted over. `flow-root` keeps the nav's top
  // margin inside the section (overflow: clip doesn't stop it collapsing
  // through, which would open a dark band above the light rays).
  return (
    <section className="relative z-[1] flow-root overflow-x-clip">
      {/* Background layers — full-bleed from the true page top, behind the
          nav too (Figma's own "back" art frame starts above the hero
          section's nominal top edge for the same reason). */}
      <div className="pointer-events-none absolute inset-0">
        {/* The grid asset only draws lines inside a masked window near its
            own right side; anchoring it past the hero's right edge puts that
            window under the light rays instead of left of them. */}
        <Image
          src="/landing/hero-bg-grid.svg"
          alt=""
          width={1429}
          height={1013}
          className="absolute right-[-260px] top-0 max-w-none opacity-40"
        />
        {/* Phone: the ray cluster is sized for the 1440 frame; scaled down
            from the corner it stays a soft top-right glow instead of washing
            over the whole hero. */}
        <HeroBeams className="absolute right-0 top-0 max-[720px]:origin-top-right max-[720px]:scale-[0.6] max-[720px]:opacity-80" />
        <HeroDots className="absolute right-[40px] top-[47px] max-[720px]:right-[10px] max-[720px]:top-[20px] max-[720px]:origin-top-right max-[720px]:scale-[0.7]" />
      </div>

      <Nav />

      {/* Content — px/pb match the original hero padding; pt trimmed since
          Nav (with its own mt-[20px]) now sits above this in normal flow. */}
      <div className="relative px-[257px] pb-[103px] max-[720px]:px-[10px] max-[720px]:pb-[90px]">
        {/* Horizon glow below the CTA: a wide, shallow arc whose rim sits
            just above the hero's bottom edge and fades into the stats strip.
            Two sets of geometry rather than one scaled shape — the arc is
            drawn at a fixed pixel size and centred, so a phone only ever sees
            the middle slice of it. At 800 wide with rx 480 that slice carries
            about 15px of curve across the whole screen, which reads as a
            straight line; the narrower radii below put a real arc inside the
            same viewport. */}
        <HorizonGlow
          width={800}
          height={200}
          rx={480}
          ry={170}
          apexY={144}
          blur={24}
          spread={14}
          opacity={1}
          fadeBottomFrom={170}
          fadeX={0.32}
          className="pointer-events-none absolute bottom-[-40px] left-1/2 max-w-none -translate-x-1/2 max-[720px]:hidden"
        />
        <HorizonGlow
          width={460}
          height={170}
          rx={240}
          ry={120}
          apexY={92}
          blur={20}
          spread={12}
          opacity={1}
          fadeBottomFrom={130}
          fadeX={0.26}
          className="pointer-events-none absolute bottom-[-70px] left-1/2 hidden max-w-none -translate-x-1/2 max-[720px]:block"
        />
        <div className="relative mx-auto flex w-[765px] max-w-full flex-col items-center gap-[34px] pt-[112px] text-center max-[720px]:gap-[20px] max-[720px]:pt-[60px]">
          <HeroCoins />
          <div className="flex flex-col items-center gap-[19px]">
            <h1 className="landing-fraunces text-[50px] uppercase leading-tight text-[#c9a962] max-[720px]:text-[30px] max-[720px]:leading-[37px]">
              Settu stablecoins and fiat, seamlessly
            </h1>
            <p className="landing-fraunces text-[20px] leading-[26px] text-[#fdf8f8] max-[720px]:text-[18px] max-[720px]:leading-[24px] max-[720px]:text-[#b9b5b5]">
              Stablecoins in, cash out, in minutes. No P2P traders. No
              middlemen.
            </p>
          </div>
          <a
            href="/app"
            className="rounded-[40px] bg-[rgba(201,169,98,0.6)] px-[16px] py-[16px] font-[family-name:var(--font-sora)] text-[16px] text-white transition-colors hover:bg-[rgba(201,169,98,0.8)] whitespace-nowrap max-[720px]:mt-[10px] max-[720px]:flex max-[720px]:h-[60px] max-[720px]:min-w-[192px] max-[720px]:items-center max-[720px]:justify-center max-[720px]:px-[28px]"
          >
            Convert USDC Now
          </a>
        </div>
      </div>
    </section>
  );
}
