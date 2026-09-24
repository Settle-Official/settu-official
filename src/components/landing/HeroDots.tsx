// Positions and base opacities are the exported Figma dot pattern
// (hero-floating-dots.svg), inlined so each dot can breathe on its own
// cycle. Duration/delay are staggered so they never pulse in unison.
const DOTS: ReadonlyArray<readonly [x: number, y: number, dim: boolean]> = [
  [263.5, 102.9, true],
  [302.5, 3.2, true],
  [96.5, 161.7, false],
  [212.5, 55.0, false],
  [58.5, 187.2, true],
  [148.5, 52.7, false],
  [3.5, 133.3, true],
  [55.5, 130.3, false],
  [161.5, 147.3, false],
  [219.5, 230.3, true],
  [6.5, 48.3, true],
  [41.5, 176.3, true],
  [107.5, 108.3, false],
];

export function HeroDots({ className }: { readonly className?: string }) {
  return (
    <svg
      width={306}
      height={234}
      viewBox="0 0 306 234"
      className={className}
      aria-hidden="true"
    >
      {DOTS.map(([x, y, dim], i) => (
        <circle
          key={i}
          cx={x}
          cy={y}
          r={1.5}
          fill="#D9D9D9"
          className="landing-dot"
          style={{
            transformOrigin: `${x}px ${y}px`,
            // Deterministic spread: 3.2–5.6s cycles, offsets across the pattern.
            animationDuration: `${3.2 + ((i * 7) % 5) * 0.6}s`,
            animationDelay: `-${(i * 1.3) % 4}s`,
            opacity: dim ? 0.5 : 1,
          }}
        />
      ))}
    </svg>
  );
}
