"use client";

import { useEffect } from "react";

const DESIGN_WIDTH = 1440;
const PHONE_BREAKPOINT = 720;

/**
 * Between the phone layout and the 1440px desktop frame, render the desktop
 * composition scaled to the viewport instead of reflowing it. The landing
 * page is art-directed to fixed Figma dimensions (absolute glows, the trust
 * curve, three fixed-width cards), so a proportional zoom keeps every
 * section intact on tablets where a fluid reflow would break it. Phones
 * keep their own layout (see the max-[720px] variants).
 */
export function LandingScale({ targetId }: { readonly targetId: string }) {
  useEffect(() => {
    const el = document.getElementById(targetId);
    if (!el) return;

    const apply = () => {
      const width = window.innerWidth;
      const scaled = width >= PHONE_BREAKPOINT && width < DESIGN_WIDTH;
      el.style.zoom = scaled ? String(width / DESIGN_WIDTH) : "";
    };

    apply();
    window.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("resize", apply);
      el.style.zoom = "";
    };
  }, [targetId]);

  return null;
}
