import { type ReactNode, useId } from "react";
import {
  ListingGroupIcon,
  MissingMark,
  NewWorktreeButton,
  RemoveWorktreeButton,
  worktreeSubgroupGuideClass,
} from "@/features/worktrees/worktree-actions";
import { cn } from "@/lib/utils";
import { groupPath, type ListingGroup } from "./listing-groups";

function Section({
  label,
  path,
  icon,
  missing = false,
  nested = false,
  actions,
  children,
}: {
  label: string;
  /** Shown as the label's tooltip. */
  path: string;
  icon: ReactNode;
  missing?: boolean;
  /** A checkout inside a repo group. */
  nested?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  const Heading = nested ? "h4" : "h3";
  return (
    // biome-ignore lint/a11y/useSemanticElements: a folder of rows, not a form <fieldset>
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex min-h-7 min-w-0 items-center gap-2 pl-2 text-xs text-muted-foreground">
        {icon}
        <Heading
          id={headingId}
          title={path}
          className="min-w-0 truncate font-medium text-foreground/80"
        >
          {label}
        </Heading>
        {missing && <MissingMark />}
        <div className="ml-auto flex shrink-0 items-center">{actions}</div>
      </div>
      {children}
    </div>
  );
}

/**
 * A listing in `groupListing`'s groups with compact headers (Home, `/sessions`): "New worktree"
 * on repo headers, "Remove worktree" on linked and missing worktree headers.
 */
export function GroupedListing<T>({
  label,
  groups,
  renderItems,
}: {
  label: string;
  groups: ListingGroup<T>[];
  /** One folder's items; in a `missing` one, only live agents stay usable. */
  renderItems(items: T[], missing: boolean): ReactNode;
}) {
  return (
    <ul aria-label={label} className="flex flex-col gap-4">
      {groups.map((group) => (
        <li key={`${group.kind}:${groupPath(group)}`}>
          {group.kind === "folder" ? (
            <Section label={group.label} path={group.cwd} icon={<ListingGroupIcon kind="folder" />}>
              {renderItems(group.items, false)}
            </Section>
          ) : (
            <Section
              label={group.label}
              path={group.repo}
              icon={<ListingGroupIcon kind="repo" />}
              actions={<NewWorktreeButton repo={{ path: group.repo, label: group.label }} />}
            >
              {group.items.length > 0 && renderItems(group.items, false)}
              {group.worktrees.length > 0 && (
                <div className={cn(worktreeSubgroupGuideClass, "gap-2")}>
                  {group.worktrees.map((worktree) => (
                    <Section
                      key={worktree.cwd}
                      nested
                      label={worktree.label}
                      path={worktree.cwd}
                      missing={worktree.missing}
                      icon={<ListingGroupIcon kind="worktree" />}
                      actions={
                        worktree.role === "worktree" && (
                          <RemoveWorktreeButton
                            target={{ path: worktree.cwd, label: worktree.label }}
                            name={`${group.label}/${worktree.label}`}
                          />
                        )
                      }
                    >
                      {renderItems(worktree.items, worktree.missing)}
                    </Section>
                  ))}
                </div>
              )}
            </Section>
          )}
        </li>
      ))}
    </ul>
  );
}
