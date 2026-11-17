import { BridgeExplorer } from "@/components/admin/BridgeExplorer";

// Live operational state behind the admin password: never prerender. The
// page is a shell; the explorer asks the (admin-guarded) API for data and
// shows the same password form as /admin when that answers 401.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settu Admin Bridge explorer",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <BridgeExplorer />;
}
