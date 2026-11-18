import { BridgeSettings } from "@/components/admin/BridgeSettings";

// Behind the admin password and live on-chain state: never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settu Admin Bridge settings",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <BridgeSettings />;
}
