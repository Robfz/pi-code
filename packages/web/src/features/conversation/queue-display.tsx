import { useConversation } from "@/store/context";
import { selectQueue } from "@/store/selectors";

/** Steering and follow-up messages waiting for the next turn (`live.queue`). */
export function QueueDisplay() {
  const queue = useConversation(selectQueue);
  const items = [
    ...queue.steering.map((text) => ({ kind: "Steer", text })),
    ...queue.followUp.map((text) => ({ kind: "Queued", text })),
  ];
  if (items.length === 0) return null;
  return (
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
  );
}
