import { Fraunces, Inter, Sora } from "next/font/google";
import { AppShell } from "@/components/app/AppShell";
import { WalletBarProvider } from "@/components/app/WalletBar";
import { AgentUnreadProvider } from "@/components/app/AgentUnread";
import { NotificationsProvider } from "@/components/app/Notifications";
import { ScreenBackProvider } from "@/components/app/ScreenBack";
import { AgentConversationProvider } from "@/components/app/AgentConversation";

// The product UI shares the landing page's type system.
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
  weight: ["400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

export default function AppLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      className={`${fraunces.variable} ${sora.variable} ${inter.variable} font-[family-name:var(--font-sora)] text-white`}
    >
      <WalletBarProvider>
        <AgentUnreadProvider>
          <NotificationsProvider>
            <ScreenBackProvider>
              <AgentConversationProvider>
                <AppShell>{children}</AppShell>
              </AgentConversationProvider>
            </ScreenBackProvider>
          </NotificationsProvider>
        </AgentUnreadProvider>
      </WalletBarProvider>
    </div>
  );
}
