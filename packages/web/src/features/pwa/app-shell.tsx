import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StopOrDeleteProvider } from "@/features/sessions/stop-or-delete";
import { Sidebar } from "@/features/sidebar/sidebar";
import { WorktreeActionsProvider } from "@/features/worktrees/worktree-actions";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { useBadgeSync } from "./badge";
import { useLaunchQueue } from "./launch-queue";
import { OfflineBanner } from "./offline-banner";
import { useServiceWorkerMessages } from "./sw-messages";

const SIDEBAR_ID = "app-sidebar";

/**
 * Root layout: offline banner, badge sync, service-worker messages and launch-queue routing around
 * every screen. On desktop (≥1024px) the sidebar is docked on the left, shown on load and toggled
 * from the shell for the rest of the tab's life; below, it opens as a sheet from the conversation
 * header. Hosts the worktree dialogs and sheet (`WorktreeActionsProvider`) and the Stop-or-Delete
 * dialog (`StopOrDeleteProvider`).
 */
export function AppShell({ children }: { children: ReactNode }) {
  useServiceWorkerMessages();
  useBadgeSync();
  useLaunchQueue();
  const desktop = useIsDesktop();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // The toggle lives in the sidebar while open and in the rail while hidden, so it remounts on
  // every toggle; the new one takes over focus.
  const focusToggle = useRef(false);
  const toggleRef = useCallback((button: HTMLButtonElement | null) => {
    if (button && focusToggle.current) {
      focusToggle.current = false;
      button.focus();
    }
  }, []);
  const toggle = (
    <Button
      ref={toggleRef}
      variant="ghost"
      size="icon"
      aria-label="Toggle sidebar"
      aria-expanded={sidebarOpen}
      aria-controls={SIDEBAR_ID}
      onClick={() => {
        focusToggle.current = true;
        setSidebarOpen((open) => !open);
      }}
    >
      {sidebarOpen ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
    </Button>
  );
  return (
    <WorktreeActionsProvider>
      <StopOrDeleteProvider>
        <div className="flex min-h-dvh overflow-x-clip bg-background text-foreground">
          {desktop && (
            <aside
              id={SIDEBAR_ID}
              className={cn(
                "sticky top-0 flex h-dvh shrink-0 flex-col border-r bg-surface-side",
                sidebarOpen
                  ? "w-[280px] pt-[env(safe-area-inset-top)] [--titlebar-right:calc(100vw-280px)]"
                  : "w-10 items-center pt-[max(0.5rem,env(safe-area-inset-top),env(titlebar-area-height,0px))]",
              )}
            >
              {sidebarOpen ? <Sidebar action={toggle} /> : toggle}
            </aside>
          )}
          <div
            className={cn(
              "min-w-0 flex-1",
              desktop && (sidebarOpen ? "[--titlebar-left:280px]" : "[--titlebar-left:2.5rem]"),
            )}
          >
            <OfflineBanner />
            {children}
          </div>
        </div>
      </StopOrDeleteProvider>
    </WorktreeActionsProvider>
  );
}
