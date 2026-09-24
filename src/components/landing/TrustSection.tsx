"use client";

import { useEffect, useRef, useState } from "react";
import { SettuLogo } from "@/components/brand/SettuLogo";

const REASONS = [
  {
    title: "01- Non-custodial by design",
    body: "Your USDC moves directly from your wallet to your bank via Stellar's settlement network. Settu never holds a balance on your behalf.",
    // Figma frame offsets, relative to the 1227×495 callout group.
    left: 0,
    top: 0,
    gap: 9,
  },
  {
    title: "02- Rates locked before you commit",
    body: "You see the exact Naira amount before you sign anything. Once locked, it doesn't move against you mid-transfer.",
    left: 421,
    top: 173,
    gap: 18,
  },
  {
    title: "03- Every fee, named",
    body: "Network, bridge, and platform fees are shown separately with a plain-language reason for each , no bundled surprise charges.",
    left: 862,
    top: 346,
    gap: 17,
  },
] as const;

// Figma's "Vector 2": a 1237×544 box at (-4.5, 14) inside the callout group.
// The left end of a big oval: it starts up at the first callout's title,
// arcs down-left behind its body text, turns beside the dashed rule, then
// sweeps along the bottom out to the third callout's rule.
const CURVE =
  "M168,-14 C70,-10 -2,60 -2,146 C-2,240 190,314 322,344 C472,381 720,404 878,388";

/**
 * Scroll-scrubbed progress for the curve: 0 while the section is still
 * below the fold, 1 once it has scrolled most of the way up. Reverses when
 * scrolling back, so the gold retreats along the path too.
 */
function useScrollProgress(ref: React.RefObject<HTMLElement | null>) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setProgress(1);
      return;
    }

    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // 0 as the section's top crosses 85% of the viewport, 1 once its
      // bottom edge reaches the viewport's bottom (so a section that fits
      // on screen is fully gold by the time it's fully in view).
      const start = vh * 0.85;
      const span = Math.max(1, rect.height - vh * 0.15);
      const p = (start - rect.top) / span;
      setProgress(Math.min(1, Math.max(0, p)));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref]);

  return progress;
}

/**
 * Each callout rides the same scroll progress as the curve, over its own
 * staggered window: 0 → still 140px below its spot and invisible, 1 → in
 * place. Eased so it decelerates into position.
 */
function slideIn(progress: number, index: number) {
  const start = 0.04 + index * 0.24;
  const t = Math.min(1, Math.max(0, (progress - start) / 0.34));
  const eased = 1 - Math.pow(1 - t, 3);
  return { transform: `translateY(${(1 - eased) * 140}px)`, opacity: eased };
}

export function TrustSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const progress = useScrollProgress(sectionRef);

  return (
    <section
      ref={sectionRef}
      id="security"
      className="relative flex flex-col items-center gap-[30px] overflow-hidden bg-[#121212] p-[100px] max-[720px]:gap-[40px] max-[720px]:p-[20px]"
    >
      <div className="flex w-[890px] max-w-full flex-col items-center gap-[20px] text-center">
        <div className="flex items-center justify-center">
          <SettuLogo className="h-[40px] w-auto" />
        </div>
        <div className="flex flex-col gap-[14px] max-[720px]:items-center max-[720px]:gap-[10px]">
          <h2 className="landing-fraunces text-[36px] leading-[44px] text-[#e5dfdf] max-[720px]:w-[272px] max-[720px]:text-[26px] max-[720px]:leading-[32px] max-[720px]:text-white">
            Why people trust it with real money
          </h2>
          <p className="font-[family-name:var(--font-sora)] text-[20px] leading-[25px] text-[#888787] max-[720px]:w-[310px] max-[720px]:text-[14px] max-[720px]:leading-[22px] max-[720px]:text-[#beb9b9]">
            Not badges — specifics about what happens to your funds, and what
            other users actually say.
          </p>
        </div>
      </div>

      {/* Desktop: Figma's absolute layout. Narrow: the same callouts stacked,
          curve hidden since it only makes sense against the diagonal. */}
      <div className="relative h-[495px] w-[1227px] max-w-full max-[720px]:flex max-[720px]:h-auto max-[720px]:flex-col max-[720px]:gap-[51px]">
        <svg
          width={1237}
          height={544}
          viewBox="0 0 1237 544"
          className="pointer-events-none absolute left-[-4.5px] top-[14px] max-w-none overflow-visible max-[720px]:hidden"
          aria-hidden="true"
        >
          <path d={CURVE} className="landing-trust-curve-base" />
          <path
            d={CURVE}
            pathLength={1}
            className="landing-trust-curve-gold"
            style={{ strokeDashoffset: 1 - progress }}
          />
        </svg>

        {REASONS.map((reason, i) => (
          <article
            key={reason.title}
            className={`landing-trust-reason absolute flex w-[366px] max-w-full items-center max-[720px]:static max-[720px]:w-full ${
              // Figma's phone frame mirrors the middle callout: text
              // right-aligned, rule on the right.
              i === 1 ? "max-[720px]:flex-row-reverse max-[720px]:text-right" : ""
            }`}
            style={{
              left: reason.left,
              top: reason.top,
              gap: reason.gap,
              ...slideIn(progress, i),
            }}
          >
            <span className="h-[146px] shrink-0 border-l border-dashed border-[#c9a962]" />
            <div
              className={`flex w-[348px] max-w-full flex-col gap-[12px] max-[720px]:w-full ${
                i === 1 ? "max-[720px]:items-end" : ""
              }`}
            >
              <h3 className="landing-fraunces whitespace-nowrap text-[20px] font-semibold leading-[25px] text-white max-[720px]:whitespace-normal max-[720px]:text-[17px] max-[720px]:leading-[22px]">
                {reason.title}
              </h3>
              <p className="font-[family-name:var(--font-sora)] text-[18px] leading-[28px] text-[#c2bdbd] max-[720px]:text-[15px] max-[720px]:leading-[24px]">
                {reason.body}
              </p>
            </div>
          </article>
        ))}
      </div>

    </section>
  );
}
