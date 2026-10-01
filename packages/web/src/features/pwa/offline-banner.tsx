import { CloudOffIcon, LoaderIcon, RefreshCwIcon, WifiOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useServerStatus } from "./server-status";

/**
 * Floating pill under the screen headers while the device is offline or the pi-code server
 * doesn't answer; the rest of the app (the precached shell) stays usable. Rendered at the top of
 * the content column, it sticks there (zero height, no layout shift) centered in the column, clear
 * of the docked sidebar.
 */
export function OfflineBanner() {
  const { status, checking, retry } = useServerStatus();
  if (status === "online") return null;
  const offline = status === "offline";
  return (
    <div className="pointer-events-none sticky top-0 z-50 flex h-0 items-start justify-center px-3">
      <div
        role="alert"
        data-testid="offline-banner"
        data-state={status}
        className="pointer-events-auto mt-[calc(env(safe-area-inset-top)+3.25rem)] flex max-w-full min-w-0 items-center gap-2 rounded-full border border-destructive/30 bg-background/95 py-1 pr-1 pl-3 text-xs shadow-lg backdrop-blur"
      >
        {offline ? (
          <WifiOffIcon className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <CloudOffIcon className="size-3.5 shrink-0 text-destructive" />
        )}
        <span className="min-w-0 truncate">
          {offline ? "You're offline" : "Can't reach the pi-code server"}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="rounded-full"
          aria-label="Retry"
          disabled={checking}
          onClick={retry}
        >
          {checking ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
        </Button>
      </div>
    </div>
  );
}
