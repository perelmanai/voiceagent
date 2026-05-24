"use client";

import dynamic from "next/dynamic";
import { DashboardShell } from "@/components/dashboard-shell";

// Skips SSR for the full dashboard so the HTML shell is returned instantly.
// The heavy client bundle (icons, QR, speech UI) loads in parallel after paint.
const Dashboard = dynamic(
  () => import("@/components/dashboard").then((m) => m.Dashboard),
  { ssr: false, loading: () => <DashboardShell /> }
);

export function DashboardLoader() {
  return <Dashboard />;
}
