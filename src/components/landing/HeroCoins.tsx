import Image from "next/image";

// The three pieces of the Figma illustration, split so they can animate.
// Positions/sizes are each piece's crop box inside the original 900×600
// artwork, as percentages, so the cluster scales as one unit.
const pct = (n: number, of: number) => `${(n / of) * 100}%`;

const LAYERS = {
  usdc: { src: "/landing/hero-coin-usdc.png", x: 22, y: 96, w: 377, h: 402 },
  toggle: { src: "/landing/hero-swap-toggle.png", x: 355, y: 193, w: 194, h: 194 },
  bank: { src: "/landing/hero-coin-bank.png", x: 503, y: 117, w: 385, h: 413 },
};

export function HeroCoins() {
  return (
    <div
      className="landing-coins relative w-[417px] max-w-full max-[720px]:w-[232px]"
      style={{ aspectRatio: "900 / 600" }}
      role="img"
      aria-label="Coins converting to a bank deposit"
    >
      {(["usdc", "toggle", "bank"] as const).map((key) => {
        const l = LAYERS[key];
        return (
          <Image
            key={key}
            src={l.src}
            alt=""
            width={l.w}
            height={l.h}
            priority
            className={`landing-coin landing-coin-${key} absolute h-auto`}
            style={{ left: pct(l.x, 900), top: pct(l.y, 600), width: pct(l.w, 900) }}
          />
        );
      })}
    </div>
  );
}
