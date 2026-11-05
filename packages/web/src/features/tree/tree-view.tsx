/**
 * The session tree (`docs/design/03-web-client.md`, "Tree screen"): one compact row per shown
 * entry with a git-graph-style gutter, as an ARIA tree with roving focus. The selected row (and
 * on hover-capable screens the hovered one) shows its Go here / Fork from here buttons in place
 * of its timestamp, in a slot as wide as either, so selecting never shifts the layout. A
 * conversation attached to a PR has neither: the server refuses both (design/10-pr-review.md).
 */

import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  GitBranchIcon,
  GitForkIcon,
  GitMergeIcon,
  LoaderIcon,
  ShrinkIcon,
  UserIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useSessionActions } from "@/features/conversation/session-actions";
import { useConversationPr } from "@/features/review/pr";
import { useReviewStore } from "@/features/review/review-state";
import { errorMessage, navigateTree } from "@/lib/api";
import { formatRelative } from "@/lib/time";
import { useIsDesktop } from "@/lib/use-media-query";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useConversation, useConversationStore } from "@/store/context";
import { waitForSeq } from "@/store/conversation-store";
import { selectIsRunning, selectLabels } from "@/store/selectors";
import {
  buildTreeModel,
  flattenTree,
  type TreeItem,
  type TreeRow,
  type TreeRowKind,
} from "./tree-model";

const ICONS = {
  user: UserIcon,
  assistant: BotIcon,
  compaction: ShrinkIcon,
  branch_summary: GitMergeIcon,
} as const;

const NO_COLLAPSED: string[] = [];

/** How long Go here waits for the stream to deliver the navigation before routing anyway. */
const NAVIGATION_SYNC_TIMEOUT_MS = 1500;

/** Go here's form: the summary choice, its optional instructions, Cancel and Go here. */
function NavigateForm({
  item,
  busy,
  setBusy,
  onClose,
}: {
  item: TreeItem;
  busy: boolean;
  setBusy(busy: boolean): void;
  onClose(): void;
}) {
  const store = useConversationStore();
  const agentId = useConversation((s) => s.agentId);
  const navigate = useNavigate();
  const [summarize, setSummarize] = useState(false);
  const [instructions, setInstructions] = useState("");
  // Whether the form is still on screen once the request (and `waitForSeq`) resolves.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
      // Route once the moved leaf is in the store, so the conversation opens on the new branch.
      if (result.seq !== undefined) {
        await waitForSeq(store, result.seq, NAVIGATION_SYNC_TIMEOUT_MS);
      }
      // Routed away meanwhile: the user is elsewhere now, don't pull them back.
      if (!mounted.current) return;
      onClose();
      void navigate({ to: "/agents/$agentId", params: { agentId } });
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={summarize}
          disabled={busy}
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
          disabled={busy}
          onChange={(event) => setInstructions(event.target.value)}
          className="min-h-20 text-base md:text-sm"
        />
      )}
      {busy && summarize && (
        <p data-testid="navigate-progress" className="text-sm text-muted-foreground">
          Summarizing the branch you're leaving — this can take a while.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={() => void go()}>
          {busy && <LoaderIcon className="animate-spin" />}
          {busy ? (summarize ? "Summarizing…" : "Moving…") : "Go here"}
        </Button>
      </div>
    </div>
  );
}

/** Go here's confirmation: a centered dialog on desktop, a bottom sheet on phones. */
function NavigateConfirm({ item, onClose }: { item: TreeItem; onClose(): void }) {
  const desktop = useIsDesktop();
  const [busy, setBusy] = useState(false);
  const onOpenChange = (open: boolean) => {
    if (!open && !busy) onClose();
  };
  const form = <NavigateForm item={item} busy={busy} setBusy={setBusy} onClose={onClose} />;

  if (desktop) {
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent data-testid="navigate-sheet" className="sm:max-w-md">
          <DialogHeader className="pr-8">
            <DialogTitle>Go here</DialogTitle>
            <DialogDescription className="line-clamp-3 break-words">{item.text}</DialogDescription>
          </DialogHeader>
          {form}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-testid="navigate-sheet"
        className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader className="pr-12 pb-0">
          <SheetTitle>Go here</SheetTitle>
          <SheetDescription className="line-clamp-3 break-words">{item.text}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">{form}</div>
      </SheetContent>
    </Sheet>
  );
}

/** The row element of entry `id` in the tree `list`. */
function rowElement(list: HTMLElement | null, id: string): HTMLElement | undefined {
  return Array.from(list?.children ?? []).find(
    (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.entryId === id,
  );
}

/** Row callbacks, one stable object for every row so `Row`'s memo holds. */
interface RowHandlers {
  select(id: string): void;
  toggle(id: string): void;
  goHere(id: string): void;
  fork(id: string): void;
  keyDown(event: KeyboardEvent<HTMLElement>, id: string): void;
}

/*
 * Gutter geometry, in px: rows are 28 high and columns 14 wide. Lines are 1px wide at x = 6 and
 * 1px high at y = 13 and nodes have odd sizes centred on those lines, so everything lands on
 * whole pixels.
 */
const LINE = "absolute bg-muted-foreground/35";
const VERTICAL = "left-[6px] w-px";
const COLUMN = "relative w-3.5 shrink-0";

/**
 * The guide columns, then the node: `guides` has one character per guide column, "1" where a
 * line crosses it (a string, so it compares by value in `Row`'s memo).
 */
function Gutter({
  guides,
  elbow,
  linkUp,
  linkDown,
  onPath,
  current,
}: {
  guides: string;
  elbow: TreeRow["elbow"];
  linkUp: boolean;
  linkDown: boolean;
  onPath: boolean;
  current: boolean;
}) {
  const columns: ReactNode[] = [];
  for (let k = 0; k < guides.length; k++) {
    const isElbow = elbow !== null && k === guides.length - 1;
    columns.push(
      <span key={k} className={COLUMN}>
        {isElbow ? (
          <>
            <span
              className={cn(
                LINE,
                VERTICAL,
                elbow === "first" ? "top-[13px]" : "top-0",
                elbow === "last" ? "h-3.5" : "bottom-0",
              )}
            />
            <span className={cn(LINE, "top-[13px] right-0 left-[6px] h-px")} />
          </>
        ) : (
          guides[k] === "1" && <span className={cn(LINE, VERTICAL, "inset-y-0")} />
        )}
      </span>,
    );
  }
  return (
    <span aria-hidden data-slot="tree-gutter" className="flex shrink-0 self-stretch">
      {columns}
      <span className={COLUMN}>
        {elbow !== null && <span className={cn(LINE, "top-[13px] left-0 h-px w-[6px]")} />}
        {linkUp && <span className={cn(LINE, VERTICAL, "top-0 h-3.5")} />}
        {linkDown && <span className={cn(LINE, VERTICAL, "top-[13px] bottom-0")} />}
        <span
          className={cn(
            "absolute rounded-full",
            current
              ? "top-[8px] left-[1px] size-[11px] bg-primary ring-2 ring-primary/30"
              : "top-[9px] left-[2px] size-[9px]",
            !current && (onPath ? "bg-primary" : "border border-muted-foreground/60 bg-background"),
          )}
        />
      </span>
    </span>
  );
}

interface RowProps {
  id: string;
  kind: TreeRowKind;
  text: string;
  label: string | undefined;
  timestamp: string;
  /** `timestamp` relative to a ticking clock, so the memoized row refreshes when it changes. */
  time: string;
  depth: number;
  level: number;
  guides: string;
  elbow: TreeRow["elbow"];
  linkUp: boolean;
  linkDown: boolean;
  branchPoint: boolean;
  collapsed: boolean;
  childCount: number;
  current: boolean;
  onPath: boolean;
  selected: boolean;
  disabled: boolean;
  /** No Go here / Fork from here: the conversation is attached to a PR. */
  prAttached: boolean;
  handlers: RowHandlers;
}

/**
 * Shown in place of the timestamp on the selected, hovered or focused row. Both stay laid out in
 * the same grid cell, only one visible, so the slot is as wide as the wider of the two.
 */
const ACTIONS_SHOWN =
  "invisible group-hover/row:visible group-focus-within/row:visible group-aria-selected/row:visible";
const ACTIONS_HIDE =
  "group-hover/row:invisible group-focus-within/row:invisible group-aria-selected/row:invisible";

const Row = memo(function Row({
  id,
  kind,
  text,
  label,
  timestamp,
  time,
  depth,
  level,
  guides,
  elbow,
  linkUp,
  linkDown,
  branchPoint,
  collapsed,
  childCount,
  current,
  onPath,
  selected,
  disabled,
  prAttached,
  handlers,
}: RowProps) {
  const Icon = ICONS[kind];
  const marker = kind === "compaction" || kind === "branch_summary";
  // The row is named by its preview, label and current badge, not by every button inside it.
  const nameId = useId();
  const labelledBy = [`${nameId}-text`, label && `${nameId}-label`, current && `${nameId}-current`]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      role="treeitem"
      data-testid="tree-row"
      data-entry-id={id}
      data-kind={kind}
      data-current={current ? "true" : undefined}
      data-depth={depth}
      aria-labelledby={labelledBy}
      aria-level={level}
      aria-selected={selected}
      aria-expanded={branchPoint ? !collapsed : undefined}
      tabIndex={selected ? 0 : -1}
      onClick={(event) => {
        handlers.select(id);
        // The row keeps keyboard focus whatever part of it was clicked.
        event.currentTarget.focus({ preventScroll: true });
      }}
      onKeyDown={(event) => handlers.keyDown(event, id)}
      className={cn(
        "group/row flex h-7 cursor-default items-center gap-1.5 rounded-md px-1 text-sm outline-none",
        // Offscreen rows skip layout and paint; the intrinsic size is the row's fixed height.
        "[contain-intrinsic-size:auto_1.75rem] [content-visibility:auto]",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
        current
          ? "bg-primary/8 aria-selected:bg-primary/15"
          : "hover:bg-muted/50 aria-selected:bg-muted",
        !onPath && "text-muted-foreground",
      )}
    >
      <Gutter
        guides={guides}
        elbow={elbow}
        linkUp={linkUp}
        linkDown={linkDown}
        onPath={onPath}
        current={current}
      />
      {branchPoint ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={collapsed ? "Expand branches" : "Collapse branches"}
          title={collapsed ? "Expand branches" : "Collapse branches"}
          onClick={() => handlers.toggle(id)}
          className="-ml-1 flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5" />
          ) : (
            <ChevronDownIcon className="size-3.5" />
          )}
        </button>
      ) : (
        // The chevron's slot, so a row's text starts at the same place whatever its kind.
        <span className="-ml-1 size-4 shrink-0" />
      )}
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          kind === "user" && onPath ? "text-foreground" : "text-muted-foreground",
        )}
      />
      <span
        id={`${nameId}-text`}
        title={text}
        className={cn("min-w-0 flex-1 truncate", marker && "text-xs text-muted-foreground italic")}
      >
        {text}
      </span>
      {label && (
        <Badge
          id={`${nameId}-label`}
          variant="secondary"
          title={label}
          className="h-4 max-w-24 px-1.5 text-[11px]"
        >
          <span className="truncate">{label}</span>
        </Badge>
      )}
      {collapsed && (
        <Badge
          variant="outline"
          title={`${childCount} branches hidden`}
          className="h-4 gap-0.5 px-1 text-[11px] text-muted-foreground"
        >
          <GitBranchIcon />+{childCount}
          <span className="sr-only"> branches hidden</span>
        </Badge>
      )}
      {current && (
        <Badge id={`${nameId}-current`} className="h-4 px-1.5 text-[10px]">
          current
        </Badge>
      )}
      <span className="grid shrink-0 items-center justify-items-end *:[grid-area:1/1]">
        <time
          dateTime={timestamp}
          title={new Date(timestamp).toLocaleString()}
          className={cn(
            "text-[11px] text-muted-foreground tabular-nums",
            !prAttached && ACTIONS_HIDE,
          )}
        >
          {time}
        </time>
        {!prAttached && (
          <span className={cn("flex items-center", ACTIONS_SHOWN)}>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Go here"
              title={current ? "Already here" : "Go here"}
              disabled={disabled || current}
              onClick={() => handlers.goHere(id)}
            >
              <CornerDownRightIcon />
            </Button>
            {kind === "user" && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Fork from here"
                title="Fork from here"
                disabled={disabled}
                onClick={() => handlers.fork(id)}
              >
                <GitForkIcon />
              </Button>
            )}
          </span>
        )}
      </span>
    </div>
  );
});

/**
 * The session tree with Go here / Fork from here (not when attached to a PR), without a header of
 * its own: the tree screen's body and the review pane's Tree tab. Built from the live store's
 * transcript (every branch) and labels, so it follows SSE updates without refetching. Collapsed
 * branch points live in the review store, so they survive switching tabs; the selection is
 * local. It doesn't scroll by itself; its host does, and the run notice sticks to the top of that
 * scroll area.
 */
export function TreeView() {
  const agentId = useConversation((s) => s.agentId);
  const hydrated = useConversation((s) => s.hydrated);
  const ready = useConversation((s) => s.hydrated && s.agent.status === "ready");
  const running = useConversation(selectIsRunning);
  const entries = useConversation((s) => s.transcript.entries);
  const leafId = useConversation((s) => s.transcript.leafId);
  const labels = useConversation(selectLabels);
  const prAttached = useConversationPr() !== undefined;
  const collapsedIds = useReviewStore((s) => s.reviews[agentId]?.tree.collapsed ?? NO_COLLAPSED);
  const actions = useSessionActions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [navigateTarget, setNavigateTarget] = useState<TreeItem | null>(null);
  const [forking, setForking] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const now = useNow();

  const model = useMemo(
    () => (hydrated ? buildTreeModel(entries, leafId, labels) : null),
    [hydrated, entries, leafId, labels],
  );
  const collapsed = useMemo(() => new Set(collapsedIds), [collapsedIds]);
  const rows = useMemo(() => (model ? flattenTree(model, collapsed) : []), [model, collapsed]);
  const disabled = running || !ready || forking;
  const currentId = model?.currentId ?? null;
  // Several roots hang off a virtual root at depth 0, which isn't a row.
  const levelOffset = model && model.roots.length > 1 ? 0 : 1;
  // The current row, or its nearest visible ancestor when a collapsed branch point hides it.
  const anchorId = useMemo(
    () => rows.findLast((r) => model?.activePath.has(r.item.id))?.item.id ?? null,
    [rows, model],
  );

  // The selection falls back to the anchor (else the first row) when it isn't a visible row:
  // initially, and after a leaf move or a collapse hides it.
  const selected = useMemo(() => {
    if (selectedId !== null && rows.some((r) => r.item.id === selectedId)) return selectedId;
    return anchorId ?? rows[0]?.item.id ?? null;
  }, [rows, selectedId, anchorId]);

  // What the stable row handlers act on, as of the last render.
  const latest = useRef({ rows, model, disabled, prAttached, agentId, actions });
  useLayoutEffect(() => {
    latest.current = { rows, model, disabled, prAttached, agentId, actions };
  });

  const handlers = useMemo<RowHandlers>(() => {
    const moveTo = (row: TreeRow | undefined) => {
      if (!row) return;
      setSelectedId(row.item.id);
      rowElement(listRef.current, row.item.id)?.focus();
    };
    const toggle = (id: string) =>
      useReviewStore.getState().toggleTreeBranch(latest.current.agentId, id);
    const goHere = (id: string) => {
      const { model, disabled, prAttached } = latest.current;
      const item = model?.items.get(id);
      if (!item || disabled || prAttached || id === model?.currentId) return;
      setNavigateTarget(item);
    };
    return {
      select: setSelectedId,
      toggle,
      goHere,
      async fork(id) {
        if (latest.current.disabled) return;
        setForking(true);
        await latest.current.actions.fork(id);
        setForking(false);
      },
      keyDown(event, id) {
        // Keys pressed on the row's own buttons are theirs.
        if (event.target !== event.currentTarget) return;
        const { rows } = latest.current;
        const index = rows.findIndex((r) => r.item.id === id);
        const row = rows[index];
        if (!row) return;
        switch (event.key) {
          case "ArrowDown":
            moveTo(rows[index + 1]);
            break;
          case "ArrowUp":
            moveTo(rows[index - 1]);
            break;
          case "Home":
            moveTo(rows[0]);
            break;
          case "End":
            moveTo(rows.at(-1));
            break;
          case "ArrowRight":
            if (row.branchPoint && row.collapsed) toggle(id);
            else moveTo(rows[index + 1]);
            break;
          case "ArrowLeft":
            if (row.branchPoint && !row.collapsed) toggle(id);
            else moveTo(rows.slice(0, index).findLast((r) => r.branchPoint && r.depth < row.depth));
            break;
          case "Enter":
            goHere(id);
            break;
          default:
            return;
        }
        event.preventDefault();
      },
    };
  }, []);

  // Once the tree first renders, bring the anchor into view.
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || anchorId === null) return;
    scrolled.current = true;
    rowElement(listRef.current, anchorId)?.scrollIntoView?.({
      block: "center",
      behavior: "instant",
    });
  }, [anchorId]);

  // When the focused row leaves the DOM (a leaf move, a reset, a collapse), focus would drop to
  // the body; it goes to the newly selected row instead.
  const focusedRow = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (!lost || !focusedRow.current || focusedRow.current.isConnected || selected === null) return;
    rowElement(listRef.current, selected)?.focus({ preventScroll: true });
  }, [selected]);

  return (
    <>
      {running && (
        <p
          data-testid="tree-running"
          className="sticky top-0 z-10 border-b bg-muted px-4 py-2 text-xs text-muted-foreground"
        >
          A run is in progress — tree actions are disabled until it finishes.
        </p>
      )}
      <div className="mx-auto w-full max-w-3xl px-2 py-2">
        {!hydrated && (
          <p className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" /> Loading…
          </p>
        )}
        {model && rows.length === 0 && (
          <p className="px-2 py-1 text-sm text-muted-foreground">No messages yet.</p>
        )}
        {rows.length > 0 && (
          <div
            ref={listRef}
            role="tree"
            aria-label="Session tree"
            className="flex flex-col"
            onFocus={(event) => {
              focusedRow.current = event.target;
            }}
            onBlur={(event) => {
              // Focus moved elsewhere on purpose.
              if (event.relatedTarget !== null) focusedRow.current = null;
            }}
          >
            {rows.map((row) => (
              <Row
                key={row.item.id}
                id={row.item.id}
                kind={row.item.kind}
                text={row.item.text}
                label={row.item.label}
                timestamp={row.item.timestamp}
                time={formatRelative(Date.parse(row.item.timestamp), now)}
                depth={row.depth}
                level={row.depth + levelOffset}
                guides={row.guides.map((line) => (line ? "1" : "0")).join("")}
                elbow={row.elbow}
                linkUp={row.linkUp}
                linkDown={row.linkDown}
                branchPoint={row.branchPoint}
                collapsed={row.collapsed}
                childCount={row.item.children.length}
                current={row.item.id === currentId}
                onPath={model?.activePath.has(row.item.id) === true}
                selected={row.item.id === selected}
                disabled={disabled}
                prAttached={prAttached}
                handlers={handlers}
              />
            ))}
          </div>
        )}
      </div>
      {navigateTarget && (
        <NavigateConfirm item={navigateTarget} onClose={() => setNavigateTarget(null)} />
      )}
    </>
  );
}
