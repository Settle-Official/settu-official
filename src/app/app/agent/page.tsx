import { StellarampDashboard } from "@/components/StellarampDashboard";

// Interim: the existing agent surface inside the new app shell, until this
// screen's redesign lands.
export default function Page() {
  return <StellarampDashboard initialMode="agent" embedded />;
}
