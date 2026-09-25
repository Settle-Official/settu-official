import { Fraunces, Sora, Inter } from "next/font/google";
import { Hero } from "./Hero";
import { Nav } from "./Nav";
import { StatsStrip } from "./StatsStrip";
import { HowItWorks } from "./HowItWorks";
import { TrustSection } from "./TrustSection";
import { Faq } from "./Faq";
import { Footer } from "./Footer";
import { LandingScale } from "./LandingScale";
import "./landing.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK"],
  variable: "--font-fraunces",
  display: "swap",
});
const sora = Sora({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-sora",
  display: "swap",
});
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

// The page ground must match the sections painted on it: every landing
// section is #121212, and this wrapper was #131212. One point of red is
// enough to draw a visible seam at each section boundary — most obviously
// across the hero's horizon glow, where it cut straight through the arc.
export function LandingPage() {
  return (
    <main
      id="landing-root"
      className={`${fraunces.variable} ${sora.variable} ${inter.variable} min-h-screen bg-[#121212] text-white font-[family-name:var(--font-sora)]`}
    >
      <LandingScale targetId="landing-root" />
      <Nav />
      <Hero />
      <StatsStrip />
      <HowItWorks />
      <TrustSection />
      <Faq />
      <Footer />
    </main>
  );
}
