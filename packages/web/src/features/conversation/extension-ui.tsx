import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { stripAnsi } from "@/lib/ansi";
import { baseName } from "@/lib/content";
import { useConversation } from "@/store/context";
import { selectNotices, selectStatuses, selectWidgets } from "@/store/selectors";

/** `setWidget` blocks for one placement: monospace, ANSI stripped. */
export function Widgets({ placement }: { placement: "aboveEditor" | "belowEditor" }) {
  const widgets = useConversation(selectWidgets);
  const entries = Object.entries(widgets).filter(([, w]) => w.placement === placement);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-testid={`widgets-${placement}`}>
      {entries.map(([key, widget]) => (
        <pre
          key={key}
          data-widget={key}
          className="overflow-x-auto rounded-lg bg-muted/40 px-2.5 py-1.5 font-mono text-xs leading-snug whitespace-pre"
        >
          {widget.lines.map(stripAnsi).join("\n")}
        </pre>
      ))}
    </div>
  );
}

/** `setStatus` chips (ANSI stripped). */
export function StatusChips() {
  const statuses = useConversation(selectStatuses);
  const entries = Object.entries(statuses);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" data-testid="status-chips">
      {entries.map(([key, text]) => (
        <Badge key={key} variant="secondary" title={key} className="max-w-full font-normal">
          <span className="truncate">{stripAnsi(text)}</span>
        </Badge>
      ))}
    </div>
  );
}

/** Notice ids already toasted, per agent, for the page's lifetime. */
const seenNotices = new Map<string, Set<string>>();

/**
 * Toasts each `notify` once. Notices already in the first snapshot of this page session are
 * history and aren't toasted.
 */
export function NoticeToaster() {
  const agentId = useConversation((s) => s.agentId);
  const hydrated = useConversation((s) => s.hydrated);
  const notices = useConversation(selectNotices);
  useEffect(() => {
    if (!hydrated) return;
    let seen = seenNotices.get(agentId);
    if (seen === undefined) {
      seenNotices.set(agentId, new Set(notices.map((n) => n.id)));
      return;
    }
    for (const notice of notices) {
      if (seen.has(notice.id)) continue;
      seen.add(notice.id);
      const message = stripAnsi(notice.message);
      if (notice.kind === "error") toast.error(message);
      else if (notice.kind === "warning") toast.warning(message);
      else toast.info(message);
    }
    if (seen.size > 200) {
      seen = new Set(notices.map((n) => n.id));
      seenNotices.set(agentId, seen);
    }
  }, [agentId, hydrated, notices]);
  return null;
}

/** For tests: forget toasted notices. */
export function resetSeenNotices(): void {
  seenNotices.clear();
}

/** `setTitle` → `document.title`; otherwise session name or folder. Restored on unmount. */
export function DocumentTitle() {
  const title = useConversation((s) => s.live.title);
  const name = useConversation((s) => s.agent.sessionName);
  const cwd = useConversation((s) => s.agent.cwd);
  const original = useRef<string | null>(null);
  useEffect(() => {
    if (original.current === null) original.current = document.title;
  }, []);
  useEffect(() => {
    const fallback = name ?? (cwd ? baseName(cwd) : "");
    document.title = title ? stripAnsi(title) : fallback ? `${fallback} · pi-code` : "pi-code";
  }, [title, name, cwd]);
  useEffect(
    () => () => {
      document.title = original.current ?? "pi-code";
    },
    [],
  );
  return null;
}
