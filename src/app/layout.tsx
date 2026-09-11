import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["100", "200", "300", "400", "500", "600", "700"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-ibm-plex-mono",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  variable: "--font-space-grotesk",
});

export const metadata: Metadata = {
  title: "Settu - Swift & Seamless",
  description: "Wallet-first Web3 offramp flow for Stellar Blockchain",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Settu",
  },
  icons: {
    apple: "/icons/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#C9A962",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${ibmPlexMono.className} ${ibmPlexMono.variable} ${spaceGrotesk.variable}`}
      >
        {children}
        <script
          dangerouslySetInnerHTML={{
            // Production only. Dev rebuilds change chunk filenames constantly,
            // so a cached shell ends up pointing at chunks that no longer
            // exist — "Loading chunk … failed". In dev, actively tear down any
            // worker a previous run left behind and drop its caches, otherwise
            // it keeps serving that stale shell long after this change.
            __html:
              process.env.NODE_ENV === "production"
                ? `if ('serviceWorker' in navigator) { window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js')); }`
                : `if ('serviceWorker' in navigator) { navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())); if (window.caches) { caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))); } }`,
          }}
        />
      </body>
    </html>
  );
}
