"use client";

import { MARK } from "./logo-geometry";
import { Gradients, Shapes, useLogoPrefix } from "./svg-parts";

// The two shapes that together make the mark's full outline: the ribbon's
// silhouette and the bar stub below it. Everything else is shading on top.
const OUTLINE = MARK.shapes.filter((s) => s.fill === "s-rim" || s.fill === "s-shadow");

export interface SettuLoaderProps {
  readonly className?: string;
  /** Announced to screen readers. */
  readonly label?: string;
}

/**
 * The $ mark as a loader. A band of light travels down the ribbon — the
 * direction the mark itself reads, an S running down into its arrow — and is
 * clipped to the silhouette so it only ever lights the ribbon, never the
 * space around it. Under prefers-reduced-motion the sweep is dropped and the
 * mark only breathes (see globals.css).
 */
export function SettuLoader({ className = "h-14 w-auto", label = "Loading" }: SettuLoaderProps) {
  const prefix = useLogoPrefix();
  return (
    <span role="status" aria-label={label} className="inline-flex">
      <svg viewBox={MARK.viewBox} className={`settu-loader ${className}`} aria-hidden="true">
        <defs>
          <Gradients gradients={MARK.gradients} prefix={prefix} />
          <clipPath id={`${prefix}clip`}>
            {OUTLINE.map((s, i) => (
              <path key={i} d={s.d} />
            ))}
          </clipPath>
          <linearGradient id={`${prefix}sheen`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff6dc" stopOpacity="0" />
            <stop offset="0.5" stopColor="#fff6dc" stopOpacity="0.92" />
            <stop offset="1" stopColor="#fff6dc" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="settu-loader-mark">
          <Shapes shapes={MARK.shapes} prefix={prefix} />
        </g>
        <g clipPath={`url(#${prefix}clip)`}>
          {/* The skew is on the group so the animated transform on the rect
              doesn't replace it — that turns a straight drop into a sweep. */}
          <g transform="skewY(-14)">
            <rect
              className="settu-loader-sheen"
              x="-40"
              y="-110"
              width="244"
              height="110"
              fill={`url(#${prefix}sheen)`}
            />
          </g>
        </g>
      </svg>
    </span>
  );
}
