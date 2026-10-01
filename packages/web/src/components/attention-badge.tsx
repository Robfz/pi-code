import type { Attention } from "@pi-code/protocol";
import {
  CircleCheckIcon,
  CircleXIcon,
  type LucideIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ATTENTION: Record<
  Exclude<Attention, "none">,
  { label: string; className: string; icon: LucideIcon; iconClassName: string }
> = {
  finished: {
    label: "Finished",
    className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    icon: CircleCheckIcon,
    iconClassName: "text-emerald-600 dark:text-emerald-400",
  },
  failed: {
    label: "Failed",
    className: "bg-destructive/15 text-destructive",
    icon: CircleXIcon,
    iconClassName: "text-destructive",
  },
  input: {
    label: "Needs input",
    className: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    icon: MessageCircleQuestionIcon,
    iconClassName: "text-amber-600 dark:text-amber-400",
  },
};

/** An agent's attention (finished, failed, needs input); nothing when there is none. */
export function AttentionBadge({
  attention,
  className,
}: {
  attention: Attention;
  className?: string;
}) {
  if (attention === "none") return null;
  const { label, className: color } = ATTENTION[attention];
  return <Badge className={cn(color, className)}>{label}</Badge>;
}

/** Compact `AttentionBadge`: a colored icon labelled (and titled) with the attention. */
export function AttentionIcon({ attention }: { attention: Attention }) {
  if (attention === "none") return null;
  const { label, icon: Icon, iconClassName } = ATTENTION[attention];
  return (
    <span role="img" aria-label={label} title={label} className="flex shrink-0">
      <Icon aria-hidden className={cn("size-3.5", iconClassName)} />
    </span>
  );
}
