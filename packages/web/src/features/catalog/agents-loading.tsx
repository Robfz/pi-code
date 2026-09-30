import { LoaderIcon } from "lucide-react";
import { useLive } from "@/store/context";

/**
 * The open-agents list before the stream's first baseline: "Loading…" while it connects,
 * "Reconnecting…" once a connection has failed.
 */
export function AgentsLoading() {
  const connecting = useLive((s) => s.connection === "connecting");
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderIcon className="size-4 animate-spin" /> {connecting ? "Loading…" : "Reconnecting…"}
    </p>
  );
}
