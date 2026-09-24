"use client";

import { LETTERS, LOCKUP, MARK } from "./logo-geometry";
import { Gradients, Shapes, useLogoPrefix } from "./svg-parts";

export interface SettuLogoProps {
  /** Size with height; width follows the lockup's aspect ratio (~3.9:1). */
  readonly className?: string;
  readonly decorative?: boolean;
  /**
   * Which background it sits on. The artwork was drawn for dark grounds —
   * its silver letters nearly vanish on white — so "light" swaps them for
   * graphite, and deepens the U's gold accent, whose pale end (#e5bd71) is
   * under 2:1 against white. The $ mark is unchanged in both.
   */
  readonly variant?: "dark" | "light";
}

// Same gradient directions as the silver/gold, re-coloured for a light ground.
const LIGHT_STOPS: Record<string, readonly (readonly [number, string])[]> = {
  "w-silver": [[0, "#1c1b1b"], [1, "#4a4948"]],
  "w-gold": [[0, "#8a6224"], [1, "#b58a3f"]],
};

/**
 * The full lockup: the $ mark followed by "ETTU".
 *
 * The mark here is the same geometry as SettuMark, placed at the letters'
 * scale — not a second tracing — so the two can never drift apart.
 */
export function SettuLogo({
  className = "h-7 w-auto",
  decorative = false,
  variant = "dark",
}: SettuLogoProps) {
  const prefix = useLogoPrefix();
  const letterGradients =
    variant === "light"
      ? LETTERS.gradients.map((g) => ({ ...g, stops: LIGHT_STOPS[g.id] ?? g.stops }))
      : LETTERS.gradients;
  return (
    <svg
      viewBox={LOCKUP.viewBox}
      className={className}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "Settu" })}
    >
      <defs>
        <Gradients gradients={MARK.gradients} prefix={prefix} />
        <Gradients gradients={letterGradients} prefix={prefix} />
      </defs>
      <g transform={LOCKUP.markTransform}>
        <Shapes shapes={MARK.shapes} prefix={prefix} />
      </g>
      <Shapes shapes={LETTERS.shapes} prefix={prefix} />
    </svg>
  );
}
