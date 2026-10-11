import type { AgentInfo } from "@pi-code/protocol";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import {
  FolderGit2Icon,
  FolderIcon,
  GitBranchPlusIcon,
  GitForkIcon,
  LoaderIcon,
  Trash2Icon,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorMessage, isApiRequestError, removeWorktree } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import { NewWorktreeSheet, type RepoTarget } from "./new-worktree-sheet";

/** A linked or missing worktree: its folder and its listing label. */
export interface WorktreeTarget {
  path: string;
  label: string;
}

interface WorktreeActions {
  /**
   * "Remove worktree": confirm, `DELETE`, and on `worktree_dirty` confirm again for `force`.
   * A no-op while a removal runs: one at a time, so the second confirmation is always for it.
   */
  requestRemove(target: WorktreeTarget): void;
  /** The path whose `DELETE` is in flight. */
  removing: string | undefined;
  /** The "New worktree" sheet for `repo`; `onOpened` runs with the new agent. */
  openNewWorktree(repo: RepoTarget, onOpened?: (agent: AgentInfo) => void): void;
}

const WorktreeActionsContext = createContext<WorktreeActions | null>(null);

interface Removal {
  target: WorktreeTarget;
  force: boolean;
}

const REMOVE_KEY = ["remove-worktree"] as const;

/**
 * Owns the remove dialogs and the "New worktree" sheet, mounted once at the app root so they
 * outlive the surface that opened them (a list that empties, a closed sidebar sheet).
 */
export function WorktreeActionsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // Targets outlive `open` so the dialog and the sheet hold their text while they close.
  const [removeOpen, setRemoveOpen] = useState(false);
  const [step, setStep] = useState<{ target: WorktreeTarget; dirty: boolean } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [newIn, setNewIn] = useState<{
    repo: RepoTarget;
    onOpened: ((agent: AgentInfo) => void) | undefined;
  } | null>(null);
  const removing = useMutationState({
    filters: { mutationKey: REMOVE_KEY, status: "pending" },
    select: (mutation) => (mutation.state.variables as Removal | undefined)?.target.path,
  });
  const remove = useMutation({
    mutationKey: REMOVE_KEY,
    mutationFn: ({ target, force }: Removal) => removeWorktree(target.path, force),
    onSuccess: (_, { target }) => {
      toast.success(`Removed ${target.label}`);
      // The catalog frame only covers the 7-day window; older sessions leave the lists here.
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    onError: (error, { target, force }) => {
      if (!force && isApiRequestError(error, "worktree_dirty")) {
        setStep({ target, dirty: true });
        setRemoveOpen(true);
      } else {
        toast.error(errorMessage(error));
      }
    },
  });

  const target = step?.target;
  const busy = removing.length > 0;
  const actions: WorktreeActions = {
    requestRemove: (worktree) => {
      if (busy) return;
      setStep({ target: worktree, dirty: false });
      setRemoveOpen(true);
    },
    removing: removing[0],
    openNewWorktree: (repo, onOpened) => {
      setNewIn({ repo, onOpened });
      setSheetOpen(true);
    },
  };

  return (
    <WorktreeActionsContext.Provider value={actions}>
      {children}
      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {step?.dirty ? `Remove ${target?.label} anyway?` : `Remove ${target?.label}?`}
            </DialogTitle>
            <DialogDescription className="break-words">
              {step?.dirty
                ? `${target?.label} has uncommitted changes or submodules. Changes will be lost.`
                : `Deletes ${target?.path} and its conversations (moved to the Trash) and stops the live ones; the branch is kept.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!removeOpen || busy || !step) return;
                remove.mutate({ target: step.target, force: step.dirty });
                setRemoveOpen(false);
              }}
            >
              {step?.dirty ? "Remove anyway" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <NewWorktreeSheet
        repo={newIn?.repo ?? null}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onOpened={newIn?.onOpened}
      />
    </WorktreeActionsContext.Provider>
  );
}

export function useWorktreeActions(): WorktreeActions {
  const actions = useContext(WorktreeActionsContext);
  if (actions === null) throw new Error("useWorktreeActions outside WorktreeActionsProvider");
  return actions;
}

/** A header's "New worktree" button; icon-only when `compact`. */
export function NewWorktreeButton({
  repo,
  compact = false,
  onOpened,
}: {
  repo: RepoTarget;
  compact?: boolean;
  onOpened?: (agent: AgentInfo) => void;
}) {
  const { openNewWorktree } = useWorktreeActions();
  return (
    <Button
      type="button"
      variant="ghost"
      size={compact ? "icon-xs" : "xs"}
      aria-label={`New worktree in ${repo.label}`}
      onClick={() => openNewWorktree(repo, onOpened)}
    >
      <GitBranchPlusIcon />
      {!compact && "New worktree"}
    </Button>
  );
}

/** A worktree header's "Remove" button, off while a removal runs; icon-only when `compact`. */
export function RemoveWorktreeButton({
  target,
  name,
  compact = false,
}: {
  target: WorktreeTarget;
  /** `repo/worktree`, for the accessible name. */
  name: string;
  compact?: boolean;
}) {
  const { requestRemove, removing } = useWorktreeActions();
  return (
    <Button
      type="button"
      variant="ghost"
      size={compact ? "icon-xs" : "xs"}
      aria-label={`Remove worktree ${name}`}
      disabled={removing !== undefined}
      onClick={() => requestRemove(target)}
    >
      {removing === target.path ? <LoaderIcon className="animate-spin" /> : <Trash2Icon />}
      {!compact && "Remove"}
    </Button>
  );
}

export type ListingGroupKind = "folder" | "repo" | "worktree";

const listingGroupIconClass = "size-3.5 shrink-0 text-muted-foreground";

/** Folder, repo, or worktree header icon for catalog listings (Home, sidebar, picker). */
export function ListingGroupIcon({ kind }: { kind: ListingGroupKind }) {
  const Icon = kind === "folder" ? FolderIcon : kind === "repo" ? FolderGit2Icon : GitForkIcon;
  return <Icon aria-hidden className={listingGroupIconClass} />;
}

/** Worktree sub-groups under a repo header; line aligns under the repo icon (pl-2 + half icon). */
export const worktreeSubgroupGuideClass =
  "ml-[0.9375rem] flex flex-col border-l border-border pl-2";

/** Marks a folder that no longer exists. */
export function MissingMark() {
  return (
    <span className="shrink-0 italic" title="The folder is gone">
      missing
    </span>
  );
}
