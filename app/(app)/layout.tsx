import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";

/**
 * Every app route renders inside the shell. `rail` is the @rail parallel
 * slot: a route that wants desktop sidebar content adds a page under
 * app/(app)/@rail; everything else falls through to default.tsx (no rail).
 */
export default function AppLayout({ children, rail }: { children: ReactNode; rail: ReactNode }) {
  return <AppShell rail={rail}>{children}</AppShell>;
}
