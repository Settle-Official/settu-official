"use client";

import { MARK } from "./logo-geometry";
import { Gradients, Shapes, useLogoPrefix } from "./svg-parts";

export interface SettuMarkProps {
  /** Size with height; width follows the mark's aspect ratio. */
  readonly className?: string;
  /** Hide from assistive tech when a visible name sits right beside it. */
  readonly decorative?: boolean;
}

/** The $ mark on its own. */
export function SettuMark({ className = "h-8 w-auto", decorative = false }: SettuMarkProps) {
  const prefix = useLogoPrefix();
  return (
    <svg
      viewBox={MARK.viewBox}
      className={className}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "Settu" })}
    >
      <defs>
        <Gradients gradients={MARK.gradients} prefix={prefix} />
      </defs>
      <Shapes shapes={MARK.shapes} prefix={prefix} />
    </svg>
  );
}
