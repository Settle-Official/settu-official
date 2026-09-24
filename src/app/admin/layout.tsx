import { Fraunces, Inter, Sora } from "next/font/google";

// /admin sits outside the app's route groups, so it has to load the type
// system itself — without this the console falls back to monospace.
const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK"],
  variable: "--font-fraunces",
  display: "swap",
});
const sora = Sora({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sora",
  display: "swap",
});
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-inter",
  display: "swap",
});

export default function AdminLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      className={`${fraunces.variable} ${sora.variable} ${inter.variable} min-h-screen bg-[#191818] font-[family-name:var(--font-sora)] text-white`}
    >
      {children}
    </div>
  );
}
