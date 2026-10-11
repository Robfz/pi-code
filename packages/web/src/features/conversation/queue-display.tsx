import { UndoIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { errorMessage, rpc } from "@/lib/api";
import { useConversation } from "@/store/context";
import { useDrafts } from "@/store/drafts";
import { selectQueue } from "@/store/selectors";

function joinTexts(texts: readonly string[]): string {
  return texts.filter((t) => t.trim() !== "").join("\n\n");
}

/**
 * Steering and follow-up messages waiting for the next turn (`live.queue`), ending in Stop & edit:
 * `clear_queue` then `abort`, with the queued texts put back in front of the draft.
 */
export function QueueDisplay() {
  const agentId = useConversation((s) => s.agentId);
  const queue = useConversation(selectQueue);
  const [stopping, setStopping] = useState(false);
  const items = [
    ...queue.steering.map((text) => ({ kind: "Steer", text })),
    ...queue.followUp.map((text) => ({ kind: "Queued", text })),
  ];
  if (items.length === 0) return null;

  async function stopAndEdit() {
    setStopping(true);
    try {
      const queued = await rpc(agentId, { type: "clear_queue" });
      const restored = [...(queued?.steering ?? []), ...(queued?.followUp ?? [])];
      const current = useDrafts.getState().drafts[agentId]?.text ?? "";
      useDrafts.getState().replace(agentId, joinTexts([...restored, current]));
      await rpc(agentId, { type: "abort" });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <ul data-testid="queue" aria-label="Queued messages" className="flex flex-col gap-1">
        {items.map((item, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: queue texts may repeat
            key={index}
            className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1 text-xs"
          >
            <span className="shrink-0 font-medium text-muted-foreground">{item.kind}</span>
            <span className="min-w-0 truncate">{item.text}</span>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="self-end font-normal text-muted-foreground hover:bg-accent dark:hover:bg-accent"
        disabled={stopping}
        onClick={() => void stopAndEdit()}
      >
        <UndoIcon /> Stop &amp; edit
      </Button>
    </div>
  );
}
