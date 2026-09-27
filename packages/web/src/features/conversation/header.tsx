import { Link } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { baseName } from "@/lib/content";
import { useConversation } from "@/store/context";
import { selectSessionName } from "@/store/selectors";
import { useUiPrefs } from "@/store/ui-prefs";
import { useOpenSheet } from "./action-sheets";
import { ConnectionIndicator } from "./connection-indicator";
import { useSessionActions } from "./session-actions";

/**
 * Session name · project · connection · tool expansion toggle · menu (tree, diff, fork, clone,
 * compact, rename, new session, close). Session commands need a ready agent.
 */
export function ConversationHeader() {
  const agentId = useConversation((s) => s.agentId);
  const cwd = useConversation((s) => s.agent.cwd);
  const name = useConversation(selectSessionName);
  const ready = useConversation((s) => s.hydrated && s.agent.status === "ready");
  const toolsExpanded = useUiPrefs((s) => s.toolsExpanded);
  const setToolsExpanded = useUiPrefs((s) => s.setToolsExpanded);
  const actions = useSessionActions();
  const openSheet = useOpenSheet();
  const folder = cwd ? baseName(cwd) : "";

  return (
    <header className="flex items-center gap-1 border-b bg-background/95 px-2 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="flex h-12 min-w-0 flex-1 items-center gap-1">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/" aria-label="Home">
            <ChevronLeftIcon />
          </Link>
        </Button>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <h1 className="truncate text-sm font-medium">{name ?? (folder || "Conversation")}</h1>
          {name !== undefined && folder !== "" && (
            <span className="truncate text-xs text-muted-foreground">{folder}</span>
          )}
        </div>
        <ConnectionIndicator />
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
            <DropdownMenuItem asChild>
              <Link to="/agents/$agentId/diff" params={{ agentId }}>
                <FileDiffIcon /> Diff
              </Link>
            </DropdownMenuItem>
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
            <DropdownMenuItem variant="destructive" onSelect={() => void actions.close()}>
              <PowerIcon /> Close conversation
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
