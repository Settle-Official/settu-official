import type { CSSProperties } from "react";

/**
 * The animated disc at the top of ResultCard, from the designer's prototype
 * (2026-11-02). Plays once on mount, then holds on the final icon.
 *
 * Success: a dot at 12 o'clock draws itself into a ring, the ring pulses, a
 * check draws in as the disc fills, then confetti bursts out and fades.
 * Failure: a red dot pops up inside a pink halo, the halo collapses, the X
 * draws in, and a ring of dots bursts out and settles around the disc.
 *
 * Timings were read off screen recordings of the prototype, so they're
 * within a frame or two rather than exact. Every element's resting style is
 * its final state and the keyframes only describe how it gets there, so
 * under reduced motion (animations off, see globals.css) the finished icon
 * simply shows.
 *
 * The SVG is twice the disc's size so the bursts can fly past its edge; one
 * viewBox unit is one pixel at the desktop size, and it scales with the
 * wrapper below 720px.
 */

const C = 82; // viewBox centre; the disc's radius is 41

type Vars = CSSProperties & Record<`--${string}`, string | number>;

// Node and the browser can disagree on the last digit of Math.cos/sin, and
// any difference in a rendered attribute is a hydration mismatch.
const r2 = (n: number) => Math.round(n * 100) / 100;

// A fixed pseudo-random sequence, so the confetti is the same on the server
// and the client and on every visit.
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const CONFETTI_COLOURS = ["#f7931a", "#f5d33b", "#3cb800", "#3b9dff", "#ff6b4a"];

const CONFETTI = (() => {
  const rand = seeded(7);
  return Array.from({ length: 36 }, (_, i) => {
    const angle = (i / 36) * Math.PI * 2 + rand() * 0.35;
    const start = 30 + rand() * 8;
    const end = 56 + rand() * 34;
    return {
      x: r2(C + Math.cos(angle) * start),
      y: r2(C + Math.sin(angle) * start),
      dx: r2(Math.cos(angle) * (end - start)),
      dy: r2(Math.sin(angle) * (end - start)),
      rot: Math.round(rand() * 540 - 270),
      w: r2(4 + rand() * 3.5),
      colour: CONFETTI_COLOURS[i % CONFETTI_COLOURS.length],
      delay: r2(rand() * 0.15),
    };
  });
})();

// Where the failure dots come to rest, read off the prototype's last frame:
// degrees clockwise from 3 o'clock, distance from centre, dot radius.
const FAIL_DOTS: ReadonlyArray<readonly [number, number, number]> = [
  [-125, 50, 3.2],
  [-158, 50, 2.4],
  [180, 52, 2.2],
  [140, 51, 4],
  [96, 52, 2.6],
  [40, 50, 3.2],
  [-28, 51, 4],
  [-62, 50, 2.6],
];

export function ResultIcon({ kind }: { readonly kind: "success" | "failed" }) {
  return (
    <span className="relative flex size-[82px] shrink-0 items-center justify-center max-[720px]:size-[62px]">
      <svg
        viewBox={`0 0 ${C * 2} ${C * 2}`}
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 size-[200%] -translate-x-1/2 -translate-y-1/2 overflow-visible"
      >
        {kind === "success" ? <SuccessIcon /> : <FailedIcon />}
      </svg>
    </span>
  );
}

function SuccessIcon() {
  return (
    <>
      {/* A soft glow that ripples out from the ring as it closes. */}
      <circle
        className="ri ri-s-pulse"
        cx={C}
        cy={C}
        r={41}
        fill="none"
        stroke="#3cb800"
        strokeWidth={8}
        opacity={0}
      />
      {/* The ring that draws itself from 12 o'clock, then hands over to the disc. */}
      <circle
        className="ri ri-s-ring"
        cx={C}
        cy={C}
        r={39}
        fill="none"
        stroke="#3cb800"
        strokeWidth={4}
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray="100 100"
        opacity={0}
      />
      <circle className="ri ri-s-disc" cx={C} cy={C} r={41} fill="#24ac5c" />
      <path
        className="ri ri-s-check"
        d={`M ${C - 14} ${C + 1} L ${C - 4.5} ${C + 10} L ${C + 14} ${C - 9}`}
        fill="none"
        stroke="#fff"
        strokeWidth={5}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={100}
        strokeDasharray="100 100"
      />
      {CONFETTI.map((p, i) => (
        <rect
          key={i}
          className="ri ri-s-confetti"
          x={r2(p.x - p.w / 2)}
          y={r2(p.y - 1.4)}
          width={p.w}
          height={2.8}
          rx={0.9}
          fill={p.colour}
          opacity={0}
          style={
            {
              "--dx": `${p.dx}px`,
              "--dy": `${p.dy}px`,
              "--rot": `${p.rot}deg`,
              animationDelay: `${(2.4 + p.delay).toFixed(2)}s`,
            } as Vars
          }
        />
      ))}
    </>
  );
}

function FailedIcon() {
  return (
    <>
      <circle className="ri ri-f-halo" cx={C} cy={C} r={60} fill="#fa8a88" opacity={0} />
      <circle className="ri ri-f-disc" cx={C} cy={C} r={41} fill="#fb2b28" />
      <g stroke="#fff" strokeWidth={5} strokeLinecap="round" fill="none">
        {/* Both strokes draw left to right, so they open as a ">" and cross. */}
        <path
          className="ri ri-f-stroke"
          d={`M ${C - 13} ${C - 13} L ${C + 13} ${C + 13}`}
          pathLength={100}
          strokeDasharray="100 100"
        />
        <path
          className="ri ri-f-stroke"
          d={`M ${C - 13} ${C + 13} L ${C + 13} ${C - 13}`}
          pathLength={100}
          strokeDasharray="100 100"
        />
      </g>
      {FAIL_DOTS.map(([deg, dist, r], i) => {
        const a = (deg * Math.PI) / 180;
        const cx = r2(C + Math.cos(a) * dist);
        const cy = r2(C + Math.sin(a) * dist);
        // They burst out ~12px past where they settle.
        const out = 12;
        return (
          <g
            key={i}
            className="ri ri-f-dot"
            style={
              {
                "--dx": `${r2(Math.cos(a) * out)}px`,
                "--dy": `${r2(Math.sin(a) * out)}px`,
              } as Vars
            }
          >
            <circle
              className="ri-f-dot-ring"
              cx={cx}
              cy={cy}
              r={r}
              fill="#fff"
              stroke="#fff"
              strokeWidth={1}
            />
            <circle
              className="ri-f-dot-core"
              cx={cx}
              cy={cy}
              r={r * 0.5}
              fill="#fa8a88"
            />
          </g>
        );
      })}
    </>
  );
}
