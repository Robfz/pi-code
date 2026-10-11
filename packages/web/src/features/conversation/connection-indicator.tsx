import { cn } from "@/lib/utils";
import { useConversation } from "@/store/context";
import type { ConnectionState } from "@/store/conversation-store";
import { selectConnection } from "@/store/selectors";

const LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

/** Dot + label for the SSE connection (label hidden while live). */
export function ConnectionIndicator() {
  const connection = useConversation(selectConnection);
  return (
    <span
      role="status"
      data-testid="connection"
      data-state={connection}
      title={LABELS[connection]}
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span
        className={cn(
          "size-2 rounded-full",
          connection === "live" && "bg-status-idle",
          (connection === "connecting" || connection === "reconnecting") &&
            "animate-pulse bg-status-idle",
          connection === "offline" && "bg-status-error",
        )}
      />
      <span className={cn(connection === "live" && "sr-only")}>{LABELS[connection]}</span>
    </span>
  );
}
