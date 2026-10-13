import type { AgentInfo } from "@pi-code/protocol";
import { useIsMutating, useMutation } from "@tanstack/react-query";
import { GitBranchPlusIcon, LoaderIcon } from "lucide-react";
import { type ChangeEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  sheetCenteredOnDesktop,
} from "@/components/ui/sheet";
import { useShowOpenedAgent } from "@/features/catalog/use-open-agent";
import { createWorktree, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

/** A layout repo: its container folder and its listing label. */
export interface RepoTarget {
  path: string;
  label: string;
}

/** What's wrong with a worktree folder name the server would reject, or null. */
export function nameProblem(name: string): string | null {
  if (name.includes("/")) return "The name is a single folder: no “/”.";
  if (name.startsWith(".")) return "The name can't start with “.”.";
  return null;
}

const CREATE_KEY = ["create-worktree"] as const;

const fieldClass = "flex flex-col gap-1";
const labelClass = "text-xs font-medium text-muted-foreground";
const inputClass = "h-10 font-mono text-base text-foreground md:text-sm";

function NewWorktreeForm({
  repo,
  onCreated,
}: {
  repo: RepoTarget;
  onCreated: (agent: AgentInfo) => void;
}) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const id = useId();
  const create = useMutation({
    mutationKey: CREATE_KEY,
    mutationFn: createWorktree,
    onSuccess: onCreated,
  });
  const trimmed = { name: name.trim(), branch: branch.trim(), base: base.trim() };
  const problem = nameProblem(trimmed.name);
  const canSubmit = trimmed.name !== "" && problem === null && !create.isPending;
  const edit = (set: (value: string) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    set(event.target.value);
    if (create.isError) create.reset();
  };
  const inputProps = {
    autoCapitalize: "off",
    autoCorrect: "off",
    autoComplete: "off",
    spellCheck: false,
    className: inputClass,
  } as const;

  return (
    <form
      className="flex flex-col gap-3 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        create.mutate({
          repo: repo.path,
          name: trimmed.name,
          ...(trimmed.branch === "" ? {} : { branch: trimmed.branch }),
          ...(trimmed.base === "" ? {} : { base: trimmed.base }),
        });
      }}
    >
      <div className={fieldClass}>
        <label htmlFor={`${id}-name`} className={labelClass}>
          Name
        </label>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={edit(setName)}
          placeholder="my-feature"
          aria-invalid={problem !== null}
          aria-describedby={problem !== null ? `${id}-name-error` : undefined}
          {...inputProps}
        />
      </div>
      {problem !== null && (
        <p id={`${id}-name-error`} role="alert" className="-mt-1 text-sm text-destructive">
          {problem}
        </p>
      )}
      <div className={fieldClass}>
        <label htmlFor={`${id}-branch`} className={labelClass}>
          Branch
        </label>
        <Input
          id={`${id}-branch`}
          value={branch}
          onChange={edit(setBranch)}
          placeholder={trimmed.name === "" ? "Same as the name" : trimmed.name}
          {...inputProps}
        />
      </div>
      <div className={fieldClass}>
        <label htmlFor={`${id}-base`} className={labelClass}>
          Base
        </label>
        <Input
          id={`${id}-base`}
          value={base}
          onChange={edit(setBase)}
          placeholder="origin/main"
          aria-describedby={`${id}-base-hint`}
          {...inputProps}
        />
        <p id={`${id}-base-hint`} className="text-xs text-muted-foreground">
          Defaults to origin/main, or origin/master when origin has no main.
        </p>
      </div>
      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(create.error)}
        </p>
      )}
      <Button type="submit" className="h-10" disabled={!canSubmit}>
        {create.isPending ? <LoaderIcon className="animate-spin" /> : <GitBranchPlusIcon />}
        {create.isPending ? "Fetching…" : "Create worktree"}
      </Button>
    </form>
  );
}

/**
 * "New worktree" for a layout repo: name, branch and base, empty on every open, then `POST /api/worktrees` and, like
 * `useOpenAgent`, navigate to the conversation opened in the new folder. Stays open while the
 * request runs.
 */
export function NewWorktreeSheet({
  repo,
  open,
  onOpenChange,
  onOpened,
}: {
  /** Kept set while the sheet closes, so its content holds during the animation. */
  repo: RepoTarget | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Runs with the new agent before navigating to it. */
  onOpened?: (agent: AgentInfo) => void;
}) {
  const show = useShowOpenedAgent(onOpened);
  const creating = useIsMutating({ mutationKey: CREATE_KEY }) > 0;
  // Counts opens, so each one keys a fresh, empty form.
  const [opens, setOpens] = useState({ count: 0, open });
  if (opens.open !== open) setOpens({ count: opens.count + (open ? 1 : 0), open });
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next || !creating) onOpenChange(next);
      }}
    >
      <SheetContent
        side="bottom"
        data-testid="new-worktree-sheet"
        className={cn(
          "max-h-[90dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)] lg:max-w-lg",
          sheetCenteredOnDesktop,
        )}
      >
        <SheetHeader className="pr-12">
          <SheetTitle>New worktree{repo ? ` in ${repo.label}` : ""}</SheetTitle>
          <SheetDescription>
            Fetches origin, creates the folder next to main on a new branch, and opens a
            conversation there.
          </SheetDescription>
        </SheetHeader>
        {repo && (
          <NewWorktreeForm
            key={opens.count}
            repo={repo}
            onCreated={(agent) => {
              onOpenChange(false);
              show(agent);
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
