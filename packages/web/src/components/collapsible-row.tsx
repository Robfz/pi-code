import { ChevronRightIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface CollapsibleRowProps extends Omit<ComponentProps<"div">, "children" | "title"> {
  /** 14px icon; bodies indent under the label when there is one. */
  icon?: ReactNode;
  label: ReactNode;
  /** Before the chevron (a duration); shown with it on hover, on focus and while open. */
  tail?: ReactNode;
  /** The body. Without one the row has no chevron and doesn't toggle. */
  children?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Under the row while it's collapsed (a live preview, a Review button). */
  collapsed?: ReactNode;
  labelClassName?: string;
  bodyClassName?: string;
}

const ROW =
  "group/row -mx-2 flex h-7 w-[calc(100%+1rem)] min-w-0 items-center gap-2 rounded-[7px] px-2 text-left text-sm select-none";

/**
 * The app's one disclosure (`docs/design/09-ui-overhaul.md`, "Collapsible"): a borderless 28px
 * row (icon, label, tail and chevron) over a body that opens with a 150ms height animation.
 */
export function CollapsibleRow({
  icon,
  label,
  tail,
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  collapsed,
  labelClassName,
  bodyClassName,
  className,
  ...rest
}: CollapsibleRowProps) {
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const hasBody = children !== undefined && children !== null && children !== false;
  const open = hasBody && (openProp ?? innerOpen);
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };

  const content = (
    <>
      {icon && (
        <span
          data-slot="row-icon"
          className="flex size-3.5 shrink-0 items-center justify-center text-faint-foreground [&_svg]:size-3.5"
        >
          {icon}
        </span>
      )}
      <span
        className={cn(
          "flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden whitespace-nowrap",
          labelClassName,
        )}
      >
        {label}
      </span>
      {(tail || hasBody) && (
        <span
          data-slot="row-tail"
          className={cn(
            "flex shrink-0 items-center gap-1 pl-2 text-xs text-faint-foreground tabular-nums transition-opacity",
            open
              ? "opacity-100"
              : "opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100",
          )}
        >
          {tail}
          {hasBody && (
            <ChevronRightIcon
              aria-hidden
              className="size-[13px] transition-transform duration-150 group-data-[state=open]/row:rotate-90"
            />
          )}
        </span>
      )}
    </>
  );

  if (!hasBody) {
    return (
      <div className={cn("min-w-0", className)} {...rest}>
        <div className={ROW}>{content}</div>
        {collapsed}
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("min-w-0", className)} {...rest}>
      <CollapsibleTrigger
        className={cn(
          ROW,
          "cursor-pointer outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        {content}
      </CollapsibleTrigger>
      {!open && collapsed}
      <CollapsibleContent className="overflow-hidden duration-150 data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <div className={cn(icon && "lg:pl-[22px]", bodyClassName)}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
