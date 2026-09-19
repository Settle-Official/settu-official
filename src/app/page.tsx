import { LandingPage } from "@/components/landing/LandingPage";

/**
 * Re-rendered at most every 5 minutes so the stats strip reflects real
 * settlements. Without this the page is prerendered once at build time and
 * the figures freeze at whatever they were when it was deployed — the whole
 * point of reading them from Redis is that they move.
 *
 * ISR rather than force-dynamic: a marketing page shouldn't hit Redis on
 * every visit, and stats five minutes stale are indistinguishable from live.
 */
export const revalidate = 300;

export default function Page() {
  return <LandingPage />;
}
