import type { AgentInfo, RepoLayout } from "@pi-code/protocol";
import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyPlusIcon,
  EllipsisVerticalIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitForkIcon,
  ListCollapseIcon,
  ListTreeIcon,
  PencilIcon,
  PowerIcon,
  ShrinkIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import { Fragment, type ReactElement } from "react";
import { HomeBackButton } from "@/components/home-back-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { agentLayout, agentSession } from "@/features/catalog/listing-groups";
import { useStopOrDelete } from "@/features/sessions/stop-or-delete";
import { conversationTitle } from "@/features/sidebar/sidebar-model";
import { SidebarSheet } from "@/features/sidebar/sidebar-sheet";
import { baseName } from "@/lib/content";
import { formatSeconds } from "@/lib/time";
import { useElapsed } from "@/lib/use-elapsed";
import { useIsDesktop } from "@/lib/use-media-query";
import { useConversation, useLive } from "@/store/context";
import { selectRunStartedAt, selectSessionName, selectWorking } from "@/store/selectors";
import { DENSITIES, DENSITY_LABEL, type Density, useUiPrefs } from "@/store/ui-prefs";
import { useOpenSheet } from "./action-sheets";
import { ConnectionIndicator } from "./connection-indicator";
import { useSessionActions } from "./session-actions";

/** The transcript density: its icon and, from 1024px, the current level's name. */
function DensityMenu() {
  const density = useUiPrefs((s) => s.density);
  const setDensity = useUiPrefs((s) => s.setDensity);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          aria-label="Transcript density"
          title="Transcript density"
          className="h-7 gap-1.5 rounded-[7px] px-[9px] font-normal text-muted-foreground hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground [&_svg:not([class*='size-'])]:size-3.5"
        >
          <ListCollapseIcon />
          <span className="hidden lg:inline">{DENSITY_LABEL[density].name}</span>
          <ChevronDownIcon className="-ml-0.5 size-3 text-faint-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-70 rounded-xl p-[5px]">
        <DropdownMenuLabel className="px-2 pt-1.5 pb-1 font-normal text-faint-foreground">
          Transcript density
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={density}
          onValueChange={(value) => setDensity(value as Density)}
        >
          {DENSITIES.map((level) => (
            <DropdownMenuRadioItem
              key={level}
              value={level}
              className="flex-col items-start gap-0.5 rounded-[7px] py-[7px] pl-2"
            >
              <span className="font-medium">{DENSITY_LABEL[level].name}</span>
              <span className="text-xs text-muted-foreground">
                {DENSITY_LABEL[level].description}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The checkout before the title: repo and worktree in a layout repo, else the folder. */
function folderSegments(cwd: string, layout: RepoLayout | undefined) {
  if (cwd === "") return [];
  const folder = { label: baseName(cwd), path: cwd };
  return layout === undefined || layout.role === "container"
    ? [folder]
    : [{ label: baseName(layout.repo), path: layout.repo }, folder];
}

/**
 * `repo › worktree › title` (folder › title outside a layout repo), then the branch. The title is
 * the sidebar row's. Only the title truncates: the folders, then the branch, hide whole as the
 * header narrows (container queries, so an open review pane counts too).
 */
function Breadcrumb({ agent }: { agent: AgentInfo }) {
  const name = useConversation(selectSessionName);
  const branch = useConversation((s) => s.gitStatus?.branch);
  const session = useLive((s) => agentSession(agent, s.sessions));
  const folders = folderSegments(agent.cwd, agentLayout(agent, session));
  return (
    <div className="@container flex min-w-0 flex-1 items-center gap-1.5 px-1 text-sm">
      {folders.map((folder) => (
        <Fragment key={folder.path}>
          <span
            data-testid="breadcrumb-folder"
            title={folder.path}
            className="max-w-40 shrink-0 truncate text-muted-foreground @max-2xl:hidden"
          >
            {folder.label}
          </span>
          <ChevronRightIcon
            aria-hidden
            className="size-3 shrink-0 text-faint-foreground @max-2xl:hidden"
          />
        </Fragment>
      ))}
      <h1 className="min-w-0 truncate font-medium">{conversationTitle(name, session)}</h1>
      {branch && (
        <span
          data-testid="header-branch"
          title="Branch"
          className="ml-1 flex max-w-48 shrink-0 items-center gap-1 text-muted-foreground @max-lg:hidden"
        >
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate font-mono text-[11.5px]">{branch}</span>
        </span>
      )}
    </div>
  );
}

/** "Working · 2m 13s" while the agent works (the timer from the run's start); hidden on phones. */
function RunState() {
  const working = useConversation(selectWorking);
  const elapsed = useElapsed(useConversation(selectRunStartedAt));
  if (!working) return null;
  return (
    <span
      data-testid="header-run-state"
      className="shimmer shrink-0 px-1 text-xs whitespace-nowrap tabular-nums max-sm:hidden"
    >
      Working{elapsed !== undefined && ` · ${formatSeconds(elapsed)}`}
    </span>
  );
}

/** An icon button with its label as a tooltip. */
function HeaderAction({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Back to Home · the conversations sheet (below the desktop breakpoint) · breadcrumb and branch ·
 * connection and run state · Fork… and Compact… (desktop) · density · menu: Tree, Diff and Fork…
 * below the desktop breakpoint, then Clone, Compact… (below the breakpoint), Rename…, New
 * session, Stop and Delete. Session commands need a ready agent. `inert` while a scoped sheet
 * covers it. Under Window Controls Overlay it is the title bar (`titlebar`).
 */
export function ConversationHeader({ inert }: { inert?: boolean }) {
  const agentId = useConversation((s) => s.agentId);
  const ready = useConversation((s) => s.hydrated && s.agent.status === "ready");
  const actions = useSessionActions();
  // The overview tracks the agent's current session file; the store's copy is its snapshot's.
  const storeAgent = useConversation((s) => s.agent);
  const agent = useLive((s) => s.agents[agentId]) ?? storeAgent;
  const stopOrDelete = useStopOrDelete();
  const busy = stopOrDelete.pending({ agent });
  const openSheet = useOpenSheet();
  const desktop = useIsDesktop();

  return (
    <header
      inert={inert}
      className="titlebar box-content flex h-12 shrink-0 items-center gap-1 border-b bg-surface-chrome/95 px-2 pt-[env(safe-area-inset-top)] backdrop-blur"
    >
      <HomeBackButton />
      {!desktop && <SidebarSheet />}
      <Breadcrumb agent={agent} />
      <ConnectionIndicator />
      <RunState />
      {desktop && (
        <>
          <HeaderAction label="Fork…">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Fork"
              disabled={!ready}
              onClick={() => openSheet("fork")}
            >
              <GitForkIcon />
            </Button>
          </HeaderAction>
          <HeaderAction label="Compact…">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Compact"
              disabled={!ready}
              onClick={() => openSheet("compact")}
            >
              <ShrinkIcon />
            </Button>
          </HeaderAction>
          <Separator
            orientation="vertical"
            className="mx-1 data-vertical:h-4 data-vertical:self-center"
          />
        </>
      )}
      <DensityMenu />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="More">
            <EllipsisVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!desktop && (
            <>
              <DropdownMenuItem asChild>
                <Link to="/agents/$agentId/tree" params={{ agentId }}>
                  <ListTreeIcon /> Tree
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
            </>
          )}
          <DropdownMenuItem disabled={!ready} onSelect={() => void actions.clone()}>
            <CopyPlusIcon /> Clone
          </DropdownMenuItem>
          {!desktop && (
            <DropdownMenuItem disabled={!ready} onSelect={() => openSheet("compact")}>
              <ShrinkIcon /> Compact…
            </DropdownMenuItem>
          )}
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
    </header>
  );
}
