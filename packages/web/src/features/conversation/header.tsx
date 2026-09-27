import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  EllipsisVerticalIcon,
  FileDiffIcon,
  GitBranchIcon,
  PowerIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { closeAgent, errorMessage } from "@/lib/api";
import { baseName } from "@/lib/content";
import { useConversation } from "@/store/context";
import { useUiPrefs } from "@/store/ui-prefs";
import { ConnectionIndicator } from "./connection-indicator";

/** Session name · project · connection · tool expansion toggle · menu. */
export function ConversationHeader() {
  const navigate = useNavigate();
  const agentId = useConversation((s) => s.agentId);
  const cwd = useConversation((s) => s.agent.cwd);
  const name = useConversation((s) => s.agent.sessionName);
  const toolsExpanded = useUiPrefs((s) => s.toolsExpanded);
  const setToolsExpanded = useUiPrefs((s) => s.setToolsExpanded);
  const folder = cwd ? baseName(cwd) : "";

  async function close() {
    try {
      await closeAgent(agentId);
      void navigate({ to: "/" });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

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
            <DropdownMenuItem variant="destructive" onSelect={() => void close()}>
              <PowerIcon /> Close conversation
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
