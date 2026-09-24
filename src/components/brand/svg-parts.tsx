"use client";

import { useId } from "react";
import type { LogoGradient, LogoShape } from "./logo-geometry";

/**
 * A prefix unique to one rendered logo. Every gradient in the artwork has a
 * fixed id, so two logos on one page — the landing footer repeats the lockup
 * in a marquee — would otherwise resolve each other's `url(#…)` fills.
 * useId's own characters aren't all valid in a url() fragment, so strip them.
 */
export function useLogoPrefix() {
  return `settu${useId().replace(/[^a-zA-Z0-9_-]/g, "")}-`;
}

export function Gradients({
  gradients,
  prefix,
}: {
  readonly gradients: readonly LogoGradient[];
  readonly prefix: string;
}) {
  return (
    <>
      {gradients.map((g) => (
        // userSpaceOnUse throughout: overlapping surfaces sample one shared
        // gradient field, so where they meet there is no seam.
        <linearGradient
          key={g.id}
          id={prefix + g.id}
          gradientUnits="userSpaceOnUse"
          x1={g.x1}
          y1={g.y1}
          x2={g.x2}
          y2={g.y2}
        >
          {g.stops.map(([offset, color]) => (
            <stop key={offset} offset={offset} stopColor={color} />
          ))}
        </linearGradient>
      ))}
    </>
  );
}

export function Shapes({
  shapes,
  prefix,
}: {
  readonly shapes: readonly LogoShape[];
  readonly prefix: string;
}) {
  return (
    <>
      {shapes.map((s, i) => (
        <path key={i} d={s.d} fill={`url(#${prefix}${s.fill})`} />
      ))}
    </>
  );
}
