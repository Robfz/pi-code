import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GitForkIcon,
  GitMergeIcon,
  LoaderIcon,
  MapPinIcon,
  RefreshCwIcon,
  ShrinkIcon,
  UserIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useSessionActions } from "@/features/conversation/session-actions";
import { errorMessage, navigateTree, rpc } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { useConversation } from "@/store/context";
import { selectIsRunning } from "@/store/selectors";
import { buildTreeModel, flattenTree, type TreeItem, type TreeRow } from "./tree-model";

/** Indentation stops growing past this depth so rows stay readable on phones. */
export const MAX_INDENT = 6;
const INDENT_PX = 14;

const ICONS = {
  user: UserIcon,
  assistant: BotIcon,
  compaction: ShrinkIcon,
  branch_summary: GitMergeIcon,
} as const;

function NavigateSheet({ item, onClose }: { item: TreeItem; onClose(): void }) {
  const agentId = useConversation((s) => s.agentId);
  const navigate = useNavigate();
  const [summarize, setSummarize] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      const trimmed = instructions.trim();
      const result = await navigateTree(agentId, {
        entryId: item.id,
        summarize,
        ...(summarize && trimmed !== "" ? { customInstructions: trimmed } : {}),
      });
      if (result.cancelled) {
        toast.info("Navigation cancelled");
        setBusy(false);
        return;
      }
      onClose();
      void navigate({ to: "/agents/$agentId", params: { agentId } });
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && !busy && onClose()}>
      <SheetContent
        side="bottom"
        data-testid="navigate-sheet"
        className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>Go here</SheetTitle>
          <SheetDescription className="line-clamp-3 break-words">{item.text}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={summarize}
              onChange={(event) => setSummarize(event.target.checked)}
              className="mt-0.5 size-4 accent-primary"
            />
            <span>
              Summarize the branch you're leaving
              <span className="block text-xs text-muted-foreground">
                Keeps a summary of the current branch in the context.
              </span>
            </span>
          </label>
          {summarize && (
            <Textarea
              aria-label="Summary instructions (optional)"
              placeholder="Instructions for the summary (optional)"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              className="min-h-20 text-base md:text-sm"
            />
          )}
        </div>
        <SheetFooter className="flex-row justify-end">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void go()}>
            {busy && <LoaderIcon className="animate-spin" />} Go here
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function Row({
  row,
  current,
  onPath,
  selected,
  disabled,
  onSelect,
  onToggle,
  onGoHere,
  onFork,
}: {
  row: TreeRow;
  current: boolean;
  onPath: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect(): void;
  onToggle(): void;
  onGoHere(): void;
  onFork(): void;
}) {
  const { item } = row;
  const Icon = ICONS[item.kind];
  const marker = item.kind === "compaction" || item.kind === "branch_summary";
  return (
    <li
      data-testid="tree-row"
      data-entry-id={item.id}
      data-kind={item.kind}
      data-current={current ? "true" : undefined}
      data-depth={row.depth}
      style={{ paddingLeft: Math.min(row.depth, MAX_INDENT) * INDENT_PX }}
      className="min-w-0"
    >
      <div
        className={cn(
          "flex min-w-0 items-start gap-1 rounded-lg border border-transparent",
          current && "border-primary/60 bg-primary/5",
          selected && !current && "bg-muted/60",
        )}
      >
        {row.branchPoint ? (
          <button
            type="button"
            aria-label={row.collapsed ? "Expand branches" : "Collapse branches"}
            aria-expanded={!row.collapsed}
            onClick={onToggle}
            className="mt-1.5 ml-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
          >
            {row.collapsed ? (
              <ChevronRightIcon className="size-3.5" />
            ) : (
              <ChevronDownIcon className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="w-5.5 shrink-0" />
        )}
        <button
          type="button"
          aria-expanded={selected}
          onClick={onSelect}
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2 py-1.5 pr-2 text-left",
            !onPath && "text-muted-foreground",
          )}
        >
          <Icon
            className={cn(
              "mt-0.5 size-3.5 shrink-0",
              item.kind === "user" ? "text-sky-500" : "text-muted-foreground",
            )}
          />
          <span
            className={cn(
              "line-clamp-2 min-w-0 flex-1 text-sm break-words",
              marker && "text-xs italic text-muted-foreground",
            )}
          >
            {item.text}
          </span>
          {item.label && (
            <Badge variant="secondary" className="max-w-24 shrink-0">
              <span className="truncate">{item.label}</span>
            </Badge>
          )}
          {current && (
            <Badge className="shrink-0 gap-1">
              <MapPinIcon /> current
            </Badge>
          )}
          {row.collapsed && (
            <Badge variant="outline" className="shrink-0">
              {item.children.length} branches
            </Badge>
          )}
        </button>
      </div>
      {selected && (
        <div className="flex flex-wrap gap-2 py-1.5 pl-7">
          <Button size="sm" variant="outline" disabled={disabled || current} onClick={onGoHere}>
            <MapPinIcon /> Go here
          </Button>
          {item.kind === "user" && (
            <Button size="sm" variant="outline" disabled={disabled} onClick={onFork}>
              <GitForkIcon /> Fork from here
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** `/agents/$agentId/tree`: the session tree with Go here / Fork from here. */
export function TreeScreen() {
  const agentId = useConversation((s) => s.agentId);
  const ready = useConversation((s) => s.hydrated && s.agent.status === "ready");
  const running = useConversation(selectIsRunning);
  const version = useConversation((s) => `${s.transcript.entries.length}:${s.transcript.leafId}`);
  const actions = useSessionActions();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [navigateTarget, setNavigateTarget] = useState<TreeItem | null>(null);
  const [forking, setForking] = useState(false);

  const tree = useQuery({
    queryKey: queryKeys.tree(agentId, version),
    queryFn: () => rpc(agentId, { type: "get_tree" }),
    enabled: ready,
    placeholderData: (previous) => previous,
  });
  const model = useMemo(
    () => (tree.data ? buildTreeModel(tree.data.tree, tree.data.leafId) : null),
    [tree.data],
  );
  const rows = useMemo(() => (model ? flattenTree(model, collapsed) : []), [model, collapsed]);
  const disabled = running || !ready || forking;

  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-2 pt-[env(safe-area-inset-top)]">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/agents/$agentId" params={{ agentId }} aria-label="Back to conversation">
            <ChevronLeftIcon />
          </Link>
        </Button>
        <h1 className="flex-1 text-sm font-medium">Session tree</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          disabled={!ready || tree.isFetching}
          onClick={() => void tree.refetch()}
        >
          <RefreshCwIcon className={cn(tree.isFetching && "animate-spin")} />
        </Button>
      </header>
      {running && (
        <p
          data-testid="tree-running"
          className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
        >
          A run is in progress — tree actions are disabled until it finishes.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-3">
        {(!ready || tree.isPending) && !tree.isError && (
          <p className="flex items-center gap-2 px-2 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" /> Loading…
          </p>
        )}
        {tree.isError && (
          <div role="alert" className="flex items-center gap-2 px-2 text-sm text-destructive">
            {errorMessage(tree.error)}
            <Button variant="outline" size="sm" onClick={() => void tree.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {model && rows.length === 0 && (
          <p className="px-2 text-sm text-muted-foreground">No messages yet.</p>
        )}
        {rows.length > 0 && (
          <ul aria-label="Session tree" className="flex flex-col gap-0.5">
            {rows.map((row) => (
              <Row
                key={row.item.id}
                row={row}
                current={row.item.id === model?.currentId}
                onPath={model?.activePath.has(row.item.id) === true}
                selected={selected === row.item.id}
                disabled={disabled}
                onSelect={() => setSelected((s) => (s === row.item.id ? null : row.item.id))}
                onToggle={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(row.item.id)) next.delete(row.item.id);
                    else next.add(row.item.id);
                    return next;
                  })
                }
                onGoHere={() => setNavigateTarget(row.item)}
                onFork={async () => {
                  setForking(true);
                  await actions.fork(row.item.id);
                  setForking(false);
                }}
              />
            ))}
          </ul>
        )}
      </div>
      {navigateTarget && (
        <NavigateSheet item={navigateTarget} onClose={() => setNavigateTarget(null)} />
      )}
    </div>
  );
}
