import { BrainIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Thinking block, collapsed by default. */
export function Thinking({ text, live = false }: { text: string; live?: boolean }) {
  if (text.trim() === "" && !live) return null;
  return (
    <details data-testid="thinking" className="group/thinking text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none">
        <BrainIcon className={cn("size-3.5", live && "animate-pulse")} />
        <span>{live ? "Thinking…" : "Thinking"}</span>
      </summary>
      <div className="mt-1 border-l-2 pl-3 whitespace-pre-wrap break-words italic">{text}</div>
    </details>
  );
}
