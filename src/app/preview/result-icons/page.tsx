import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Fraunces } from "next/font/google";
import { ResultIconsPreview } from "./ResultIconsPreview";

// ResultCard's headline uses Fraunces, which only the /app layout loads.
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Result icons preview",
  robots: { index: false, follow: false },
};

/**
 * A page for checking the success and failure animations (ResultIcon.tsx)
 * without running a real transaction. Available locally and on preview
 * deployments; production 404s.
 */
export default function Page() {
  if (process.env.VERCEL_ENV === "production") notFound();
  return (
    <div className={`${fraunces.variable} min-h-screen bg-[#121212] text-white`}>
      <ResultIconsPreview />
    </div>
  );
}
