/**
 * Sidebar rows and groups (`docs/design/05-desktop.md`, "Sidebar"; `06-worktrees.md`): every agent
 * in the registry plus the sessions no agent holds, grouped by `groupListing`, pinned repos first.
 */

import {
  type AgentInfo,
  type Recency,
  type RepoLayout,
  recencyOf,
  type StreamedSession,
} from "@pi-code/protocol";
import {
  agentLayout,
  agentRecency,
  groupListing,
  type ListingGroup,
} from "@/features/catalog/listing-groups";
import { type AgentStatusKind, agentStatus } from "@/lib/agent-status";
import { isLive, isWorking } from "@/lib/agents";

export interface SidebarRow {
  /** Agent id, or the session file for session rows. */
  key: string;
  title: string;
  cwd: string;
  layout?: RepoLayout;
  /** The latest scan found the folder gone. */
  missing?: true;
  /** The session's last prompt, else its creation (an agent's start before its file exists). */
  recency: Recency;
  /** Set on agent rows (exited agents included). */
  agent?: AgentInfo;
  /** The session file to resume from this row. */
  sessionFile?: string;
}

export type SidebarGroup = ListingGroup<SidebarRow>;

/** A conversation's displayed title: its name, else its session's name or first prompt. */
export function conversationTitle(
  name: string | undefined,
  session: Pick<StreamedSession, "name" | "firstMessage"> | undefined,
): string {
  return name ?? session?.name ?? session?.firstMessage ?? "New conversation";
}

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

/** Attention statuses, most urgent first. */
const URGENCY: readonly AgentStatusKind[] = ["input", "failed", "finished"];

/**
 * What a collapsed header shows of the rows it hides, as status marks: Working while one of them
 * is streaming or starting, then the most urgent status among Needs input, Failed and Finished
 * (each row's as `agentStatus` reads it).
 */
export function hiddenMarks(rows: readonly SidebarRow[]): AgentStatusKind[] {
  const agents = rows.flatMap((row) => (row.agent ? [row.agent] : []));
  const statuses = new Set(agents.map((agent) => agentStatus(agent)));
  const urgent = URGENCY.find((status) => statuses.has(status));
  return [...(agents.some(isWorking) ? (["working"] as const) : []), ...(urgent ? [urgent] : [])];
}

/** Every row of a group, its checkouts' included. */
export function allRows(group: SidebarGroup): SidebarRow[] {
  return group.kind === "folder"
    ? group.items
    : [...group.items, ...group.worktrees.flatMap((worktree) => worktree.items)];
}

const byLabel = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function buildSidebarGroups({
  agents,
  sessions,
  known = sessions,
  query = "",
  pinned = [],
  mains = {},
}: {
  /** Every agent in the registry. */
  agents: AgentInfo[];
  /** Session rows' source (every session, or search results). */
  sessions: StreamedSession[];
  /** Sessions to take agent titles, recency, layout and `missing` from. */
  known?: StreamedSession[];
  /** When set, only agent rows that `agentMatches` it are shown. */
  query?: string;
  /**
   * Pinned repos (container paths): listed first, by label. Without a query, a pinned repo with
   * no rows still gets its group.
   */
  pinned?: readonly string[];
  /**
   * Pinned repo → its main checkout. Without a query, every repo group gets its main checkout's
   * sub-group, even empty; its main comes from its rows' layout, else from here.
   */
  mains?: Readonly<Record<string, string>>;
}): SidebarGroup[] {
  const byFile = new Map(known.map((session) => [session.file, session]));
  // Built from every agent, shown or not: a held session never gets its own row.
  const held = new Set(agents.flatMap((agent) => (agent.sessionFile ? [agent.sessionFile] : [])));

  const agentRows: SidebarRow[] = agents.map((agent) => {
    const session = agent.sessionFile ? byFile.get(agent.sessionFile) : undefined;
    const layout = agentLayout(agent, session);
    return {
      key: agent.id,
      title: conversationTitle(agent.sessionName, session),
      cwd: agent.cwd,
      ...(layout ? { layout } : {}),
      ...(session?.missing ? { missing: true } : {}),
      recency: agentRecency(agent, session),
      agent,
      ...(agent.sessionFile ? { sessionFile: agent.sessionFile } : {}),
    };
  });
  const rows = query === "" ? agentRows : agentRows.filter((row) => agentMatches(row, query));
  for (const session of sessions) {
    if (held.has(session.file)) continue;
    rows.push({
      key: session.file,
      title: conversationTitle(undefined, session),
      cwd: session.cwd,
      ...(session.layout ? { layout: session.layout } : {}),
      ...(session.missing ? { missing: true } : {}),
      recency: recencyOf(session),
      sessionFile: session.file,
    });
  }

  const groups = groupListing(
    rows,
    {
      cwd: (row) => row.cwd,
      layout: (row) => row.layout,
      recency: (row) => row.recency,
      missing: (row) => row.missing === true,
    },
    query === "" ? { repos: pinned, mains } : {},
  );
  const isPinned = new Set(pinned);
  const top = groups
    .filter((group) => group.kind === "repo" && isPinned.has(group.repo))
    .sort((a, b) => byLabel.compare(a.label, b.label));
  return [...top, ...groups.filter((group) => !top.includes(group))];
}
