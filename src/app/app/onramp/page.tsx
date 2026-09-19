import { StellarampDashboard } from "@/components/StellarampDashboard";

// Interim: the existing onramp surface inside the new app shell, until this
// screen's redesign lands.
export default function Page() {
  return <StellarampDashboard initialMode="onramp" embedded />;
}
