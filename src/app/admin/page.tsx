import { AdminRecoveryConsole } from "@/components/admin/AdminRecoveryConsole";

// Never prerender: everything here is live operational state, and the page
// is behind a password that only exists at request time.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Recovery console",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminRecoveryConsole />;
}
