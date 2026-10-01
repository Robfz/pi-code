/**
 * Sidebar rows and groups (`docs/design/05-desktop.md`, "Sidebar"): every agent in the registry
 * plus the sessions no agent holds, grouped by cwd, most recent first.
 */

import type { AgentInfo, SessionSummary } from "@pi-code/protocol";
import { baseName } from "@/lib/content";

export interface SidebarRow {
  /** Agent id, or the session file for session rows. */
  key: string;
  title: string;
  cwd: string;
  /** Epoch ms: the session's `updatedAt`; for agents, the later of that and `startedAt`. */
  activity: number;
  /** Set on agent rows (exited agents included). */
  agent?: AgentInfo;
  /** The session file to resume from this row. */
  sessionFile?: string;
}

export interface SidebarGroup {
  cwd: string;
  /** Folder basename, with the parent's basename prepended when another group shares it. */
  label: string;
  /** The folder's branch, shown only while it has a live agent. */
  branch?: string;
  rows: SidebarRow[];
}

/** The pi process runs (exited agents aren't live). */
export function isLive(agent: AgentInfo): boolean {
  return agent.status !== "exited";
}

/** Case-insensitive substring match on an agent row's displayed title and cwd path. */
export function agentMatches(row: Pick<SidebarRow, "title" | "cwd">, query: string): boolean {
  const q = query.toLowerCase();
  return row.title.toLowerCase().includes(q) || row.cwd.toLowerCase().includes(q);
}

const time = (iso: string | undefined) => {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

function parentName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  return baseName(trimmed.slice(0, trimmed.lastIndexOf("/")) || "/");
}

export function buildSidebarGroups({
  agents,
  sessions,
  branches,
  known = sessions,
  query = "",
}: {
  /** Every agent in the registry. */
  agents: AgentInfo[];
  /** Session rows' source (the 7-day window, or search results). */
  sessions: SessionSummary[];
  branches: Record<string, string>;
  /** Sessions to take agent titles and activity from. */
  known?: SessionSummary[];
  /** When set, only agent rows that `agentMatches` it are shown. */
  query?: string;
}): SidebarGroup[] {
  const byFile = new Map(known.map((session) => [session.file, session]));
  // Built from every agent, shown or not: a held session never gets its own row.
  const held = new Set(agents.flatMap((agent) => (agent.sessionFile ? [agent.sessionFile] : [])));

  const agentRows: SidebarRow[] = agents.map((agent) => {
    const session = agent.sessionFile ? byFile.get(agent.sessionFile) : undefined;
    return {
      key: agent.id,
      title: agent.sessionName ?? session?.name ?? session?.firstMessage ?? "New conversation",
      cwd: agent.cwd,
      activity: Math.max(time(agent.startedAt), time(session?.updatedAt)),
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
      activity: time(session.updatedAt),
      sessionFile: session.file,
    });
  }

  const byCwd = new Map<string, SidebarRow[]>();
  for (const row of rows.sort((a, b) => b.activity - a.activity)) {
    const group = byCwd.get(row.cwd);
    if (group) group.push(row);
    else byCwd.set(row.cwd, [row]);
  }

  const basenameCount = new Map<string, number>();
  for (const cwd of byCwd.keys()) {
    basenameCount.set(baseName(cwd), (basenameCount.get(baseName(cwd)) ?? 0) + 1);
  }

  // Map insertion order follows the rows' order: groups come most recent first.
  return [...byCwd].map(([cwd, groupRows]) => {
    const name = baseName(cwd);
    const branch = branches[cwd];
    const live = groupRows.some((row) => row.agent !== undefined && isLive(row.agent));
    return {
      cwd,
      label: (basenameCount.get(name) ?? 0) > 1 ? `${parentName(cwd)}/${name}` : name,
      ...(live && branch !== undefined ? { branch } : {}),
      rows: groupRows,
    };
  });
}
