import { useId } from "react";

interface HorizonGlowProps {
  readonly width: number;
  readonly height: number;
  /** Horizontal / vertical radii of the dark "sun" whose top edge is the glowing rim. */
  readonly rx: number;
  readonly ry: number;
  /** Y position of the rim's apex inside the box. */
  readonly apexY: number;
  readonly blur: number;
  /** How far the gold extends past the rim before blurring — sets rim brightness. */
  readonly spread: number;
  readonly opacity?: number;
  /** Y from which the glow fades out toward the bottom edge (for tall domes). */
  readonly fadeBottomFrom?: number;
  /** Fraction of the width over which each end fades to nothing. */
  readonly fadeX?: number;
  /** Blur on the masked interior's edge; 0 keeps the rim crisp. */
  readonly innerBlur?: number;
  readonly className?: string;
}

// Figma builds these as a blurred gold ellipse with a background-colored
// ellipse covering its center, so only the rim glows. Masking the interior
// out instead of painting over it keeps the effect independent of the
// section's background color.
export function HorizonGlow({
  width,
  height,
  rx,
  ry,
  apexY,
  blur,
  spread,
  opacity = 0.85,
  fadeBottomFrom,
  fadeX = 0.2,
  innerBlur = 0,
  className,
}: HorizonGlowProps) {
  const id = useId();
  const cx = width / 2;
  const cy = apexY + ry;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${id}-x`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" />
          <stop offset={fadeX} stopColor="#fff" />
          <stop offset={1 - fadeX} stopColor="#fff" />
          <stop offset="1" stopColor="#000" />
        </linearGradient>
        <linearGradient id={`${id}-y`} x1="0" y1="0" x2="0" y2="1">
          <stop offset={fadeBottomFrom === undefined ? 1 : fadeBottomFrom / height} stopColor="#fff" />
          <stop offset="1" stopColor={fadeBottomFrom === undefined ? "#fff" : "#000"} />
        </linearGradient>
        <filter id={`${id}-b`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation={blur} />
        </filter>
        <filter id={`${id}-ib`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation={innerBlur} />
        </filter>
        {/* Masks default to a region just around the masked shape, which
            would clip the halo to a hard edge; cover the whole box instead. */}
        <mask id={`${id}-rim`} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height}>
          <rect width={width} height={height} fill={`url(#${id}-x)`} />
          <ellipse
            cx={cx}
            cy={cy}
            rx={rx}
            ry={ry}
            fill="#000"
            filter={innerBlur > 0 ? `url(#${id}-ib)` : undefined}
          />
        </mask>
        <mask id={`${id}-fade`} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height}>
          <rect width={width} height={height} fill={`url(#${id}-y)`} />
        </mask>
      </defs>
      <g mask={`url(#${id}-fade)`}>
        <ellipse
          cx={cx}
          cy={cy}
          rx={rx + spread}
          ry={ry + spread}
          fill="#FAE9B8"
          opacity={opacity}
          filter={`url(#${id}-b)`}
          mask={`url(#${id}-rim)`}
        />
      </g>
    </svg>
  );
}
