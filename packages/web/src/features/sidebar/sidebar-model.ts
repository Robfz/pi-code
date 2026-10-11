/**
 * Sidebar rows and groups (`docs/design/05-desktop.md`, "Sidebar"; `06-worktrees.md`): every agent
 * in the registry plus the sessions no agent holds, grouped by `groupListing`, most recent first.
 */

import type { AgentInfo, RepoLayout, SessionSummary } from "@pi-code/protocol";
import {
  agentLayout,
  epochMs,
  groupListing,
  type ListingGroup,
} from "@/features/catalog/listing-groups";
import { isLive } from "@/lib/agents";

export interface SidebarRow {
  /** Agent id, or the session file for session rows. */
  key: string;
  title: string;
  cwd: string;
  layout?: RepoLayout;
  /** Epoch ms: the session's `updatedAt`; for agents, the later of that and `startedAt`. */
  activity: number;
  /** Set on agent rows (exited agents included). */
  agent?: AgentInfo;
  /** The session file to resume from this row. */
  sessionFile?: string;
}

export type SidebarGroup = ListingGroup<SidebarRow>;

/** Case-insensitive substring match on an agent row's displayed title and cwd path. */
export function agentMatches(row: Pick<SidebarRow, "title" | "cwd">, query: string): boolean {
  const q = query.toLowerCase();
  return row.title.toLowerCase().includes(q) || row.cwd.toLowerCase().includes(q);
}

/** The folder's branch, while one of its rows is a live agent. */
export function liveBranch(
  branches: Record<string, string>,
  cwd: string,
  rows: readonly SidebarRow[],
): string | undefined {
  return rows.some((row) => row.agent !== undefined && isLive(row.agent))
    ? branches[cwd]
    : undefined;
}

export function buildSidebarGroups({
  agents,
  sessions,
  known = sessions,
  query = "",
}: {
  /** Every agent in the registry. */
  agents: AgentInfo[];
  /** Session rows' source (the 7-day window, or search results). */
  sessions: SessionSummary[];
  /** Sessions to take agent titles, activity and layout from. */
  known?: SessionSummary[];
  /** When set, only agent rows that `agentMatches` it are shown. */
  query?: string;
}): SidebarGroup[] {
  const byFile = new Map(known.map((session) => [session.file, session]));
  // Built from every agent, shown or not: a held session never gets its own row.
  const held = new Set(agents.flatMap((agent) => (agent.sessionFile ? [agent.sessionFile] : [])));

  const agentRows: SidebarRow[] = agents.map((agent) => {
    const session = agent.sessionFile ? byFile.get(agent.sessionFile) : undefined;
    const layout = agentLayout(agent, byFile);
    return {
      key: agent.id,
      title: agent.sessionName ?? session?.name ?? session?.firstMessage ?? "New conversation",
      cwd: agent.cwd,
      ...(layout ? { layout } : {}),
      activity: Math.max(epochMs(agent.startedAt), epochMs(session?.updatedAt)),
      agent,
      ...(agent.sessionFile ? { sessionFile: agent.sessionFile } : {}),
    };
  });
  const rows = query === "" ? agentRows : agentRows.filter((row) => agentMatches(row, query));
  for (const session of sessions) {
    if (held.has(session.file)) continue;
    rows.push({
      key: session.file,
      title: session.name ?? session.firstMessage ?? "New conversation",
      cwd: session.cwd,
      ...(session.layout ? { layout: session.layout } : {}),
      activity: epochMs(session.updatedAt),
      sessionFile: session.file,
    });
  }

  return groupListing(rows, {
    cwd: (row) => row.cwd,
    layout: (row) => row.layout,
    activity: (row) => row.activity,
  });
}
