import { Link } from "@tanstack/react-router";
import {
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CopyPlusIcon,
  EllipsisVerticalIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitForkIcon,
  PencilIcon,
  PowerIcon,
  ShrinkIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import { HomeBackButton } from "@/components/home-back-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useReviewStore } from "@/features/review/review-state";
import { useStopOrDelete } from "@/features/sessions/stop-or-delete";
import { SidebarSheet } from "@/features/sidebar/sidebar-sheet";
import { baseName } from "@/lib/content";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { useConversation, useLive } from "@/store/context";
import { selectSessionName } from "@/store/selectors";
import { useUiPrefs } from "@/store/ui-prefs";
import { useOpenSheet } from "./action-sheets";
import { ConnectionIndicator } from "./connection-indicator";
import { useSessionActions } from "./session-actions";

/**
 * Back to Home and the conversations sheet (below the desktop breakpoint only) · session name ·
 * project · connection · review pane toggle (desktop) · tool expansion toggle · menu (tree, diff
 * below the desktop breakpoint, fork, clone, compact, rename, new session, stop, delete). Session
 * commands need a ready agent. `inert` while a scoped sheet covers it.
 */
export function ConversationHeader({
  inert,
  paneOpen = false,
  className,
}: {
  inert?: boolean;
  /** Whether the desktop review pane is open. */
  paneOpen?: boolean;
  className?: string;
}) {
  const agentId = useConversation((s) => s.agentId);
  const cwd = useConversation((s) => s.agent.cwd);
  const name = useConversation(selectSessionName);
  const ready = useConversation((s) => s.hydrated && s.agent.status === "ready");
  const toolsExpanded = useUiPrefs((s) => s.toolsExpanded);
  const setToolsExpanded = useUiPrefs((s) => s.setToolsExpanded);
  const actions = useSessionActions();
  // The overview tracks the agent's current session file; the store's copy is its snapshot's.
  const storeAgent = useConversation((s) => s.agent);
  const agent = useLive((s) => s.agents[agentId]) ?? storeAgent;
  const stopOrDelete = useStopOrDelete();
  const busy = stopOrDelete.pending({ agent });
  const openSheet = useOpenSheet();
  const folder = cwd ? baseName(cwd) : "";
  const desktop = useIsDesktop();

  return (
    <header
      inert={inert}
      className={cn(
        "flex items-center gap-1 border-b bg-background/95 px-2 pt-[env(safe-area-inset-top)] backdrop-blur",
        className,
      )}
    >
      <div className="flex h-12 min-w-0 flex-1 items-center gap-1">
        <HomeBackButton />
        {!desktop && <SidebarSheet />}
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <h1 className="truncate text-sm font-medium">{name ?? (folder || "Conversation")}</h1>
          {name !== undefined && folder !== "" && (
            <span className="truncate text-xs text-muted-foreground">{folder}</span>
          )}
        </div>
        <ConnectionIndicator />
        {desktop && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={paneOpen ? "Hide changes" : "Show changes"}
            aria-pressed={paneOpen}
            onClick={() => useReviewStore.getState().togglePane(agentId)}
          >
            <FileDiffIcon />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={toolsExpanded ? "Collapse tools" : "Expand tools"}
          aria-pressed={toolsExpanded}
          onClick={() => setToolsExpanded(!toolsExpanded)}
        >
          {toolsExpanded ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More">
              <EllipsisVerticalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link to="/agents/$agentId/tree" params={{ agentId }}>
                <GitBranchIcon /> Tree
              </Link>
            </DropdownMenuItem>
            {!desktop && (
              <DropdownMenuItem asChild>
                <Link to="/agents/$agentId/diff" params={{ agentId }}>
                  <FileDiffIcon /> Diff
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!ready} onSelect={() => openSheet("fork")}>
              <GitForkIcon /> Fork…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!ready} onSelect={() => void actions.clone()}>
              <CopyPlusIcon /> Clone
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!ready} onSelect={() => openSheet("compact")}>
              <ShrinkIcon /> Compact…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!ready} onSelect={() => openSheet("rename")}>
              <PencilIcon /> Rename…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!ready} onSelect={() => void actions.newSession()}>
              <SquarePenIcon /> New session
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} onSelect={() => stopOrDelete.stop(agent)}>
              <PowerIcon /> Stop
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={busy}
              onSelect={() => stopOrDelete.remove({ agent })}
            >
              <Trash2Icon /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
