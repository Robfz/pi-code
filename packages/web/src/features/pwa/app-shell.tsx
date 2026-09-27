import type { ReactNode } from "react";
import { useBadgeSync } from "./badge";
import { OfflineBanner } from "./offline-banner";
import { useServiceWorkerMessages } from "./sw-messages";

/** Root layout: offline banner, badge sync and service-worker messages around every screen. */
export function AppShell({ children }: { children: ReactNode }) {
  useServiceWorkerMessages();
  useBadgeSync();
  return (
    <div className="min-h-dvh overflow-x-clip bg-background text-foreground">
      <OfflineBanner />
      {children}
    </div>
  );
}
