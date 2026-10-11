import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleXIcon,
  LoaderCircleIcon,
  type LucideIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { type AgentStatusKind, STATUS_LABEL } from "@/lib/agent-status";
import { cn } from "@/lib/utils";

const DOT: Record<Exclude<AgentStatusKind, "working" | "closed">, string> = {
  input: "bg-status-input ring-3 ring-status-input/15",
  failed: "bg-status-error",
  finished: "bg-status-done",
  idle: "bg-status-idle",
};

const BADGE: Record<AgentStatusKind, { icon: LucideIcon; className: string }> = {
  input: { icon: MessageCircleQuestionIcon, className: "text-status-input" },
  working: {
    icon: LoaderCircleIcon,
    className: "text-status-working [&>svg]:text-muted-foreground",
  },
  failed: { icon: CircleXIcon, className: "text-status-error" },
  finished: { icon: CircleCheckIcon, className: "text-status-done" },
  closed: { icon: CircleDashedIcon, className: "text-muted-foreground" },
  idle: { icon: CircleIcon, className: "text-muted-foreground" },
};

/** Dense status mark (the sidebar): a spinner for Working, a dot otherwise, nothing when Closed. */
export function StatusMark({ status }: { status: AgentStatusKind }) {
  if (status === "closed") return null;
  const label = STATUS_LABEL[status];
  if (status === "working") {
    return (
      <span role="img" aria-label={label} title={label} className="flex">
        <LoaderCircleIcon aria-hidden className="size-3 animate-spin text-muted-foreground" />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("size-[7px] rounded-full", DOT[status])}
    />
  );
}

/** Roomy status badge (Home, `/sessions`): the status's icon and word. */
export function StatusBadge({
  status,
  className,
}: {
  status: AgentStatusKind;
  className?: string;
}) {
  const { icon: Icon, className: color } = BADGE[status];
  return (
    <Badge variant="outline" data-status={status} className={cn(color, className)}>
      <Icon aria-hidden className={cn(status === "working" && "animate-spin")} />
      {STATUS_LABEL[status]}
    </Badge>
  );
}
