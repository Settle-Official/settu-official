import { useId } from "react";

// Every edge below aims at the same point just under the box (240, 560), so
// the rays spread across the top edge and taper down-left to meet at the
// bottom. The fan is the same cone lit softly, so the gaps between rays
// stay warm rather than dropping back to the page background.
const FAN = "280,-60 620,-60 289,480 245,480";

const RAYS = [
  "300,-60 380,-60 260,470 249,470",
  "400,-60 470,-60 273,470 263,470",
  "490,-60 580,-60 289,470 276,470",
];

// Three light rays fanning down-left from above the hero's top-right corner,
// over a soft gold haze. Anchored to the section's top-right so the rays'
// bright ends always run off the top edge.
export function HeroBeams({ className }: { readonly className?: string }) {
  const id = useId();

  return (
    <svg
      width={560}
      height={520}
      viewBox="0 0 560 520"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${id}-ray`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F1DFAE" stopOpacity="0.9" />
          <stop offset="0.5" stopColor="#D6B76E" stopOpacity="0.3" />
          <stop offset="1" stopColor="#C9A962" stopOpacity="0" />
        </linearGradient>
        {/* Weak at the top so the gaps between rays stay dark there, strongest
            mid-way down where the rays are meant to merge into one wash. */}
        <linearGradient id={`${id}-fan`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#D9BD78" stopOpacity="0.1" />
          <stop offset="0.5" stopColor="#C9A962" stopOpacity="0.3" />
          <stop offset="1" stopColor="#C9A962" stopOpacity="0" />
        </linearGradient>
        <filter id={`${id}-ray-blur`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="12" />
        </filter>
        <filter id={`${id}-fan-blur`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="40" />
        </filter>
        <filter id={`${id}-haze`} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="90" />
        </filter>
      </defs>
      <ellipse
        cx={480}
        cy={140}
        rx={170}
        ry={230}
        fill="#C9A962"
        opacity={0.4}
        filter={`url(#${id}-haze)`}
      />
      {/* The cluster breathes as a whole and each ray shimmers on its own
          offset cycle (see .landing-beams / .landing-ray in landing.css). */}
      <g style={{ mixBlendMode: "plus-lighter" }} className="landing-beams">
        <polygon points={FAN} fill={`url(#${id}-fan)`} filter={`url(#${id}-fan-blur)`} />
        {RAYS.map((points, i) => (
          <g
            key={points}
            filter={`url(#${id}-ray-blur)`}
            className="landing-ray"
            style={{ animationDelay: `-${i * 2.3}s` }}
          >
            <polygon points={points} fill={`url(#${id}-ray)`} />
          </g>
        ))}
      </g>
    </svg>
  );
}
