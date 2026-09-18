import { Fraunces, Sora, Inter } from "next/font/google";
import { Nav } from "./Nav";
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
  weight: ["400", "600"],
  variable: "--font-inter",
  display: "swap",
});

export function LandingPage() {
  return (
    <main
      className={`${fraunces.variable} ${sora.variable} ${inter.variable} min-h-screen bg-[#131212] text-white font-[family-name:var(--font-sora)]`}
    >
      <Nav />
      {/* Sections added in later tasks: Hero, StatsStrip, HowItWorks */}
    </main>
  );
}
