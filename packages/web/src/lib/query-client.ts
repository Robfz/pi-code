import { QueryClient } from "@tanstack/react-query";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: true },
    },
  });
}

const review = (agentId: string) => ["agent", agentId, "review"] as const;
const gitDiffs = (agentId: string) => [...review(agentId), "diff"] as const;
const fileSearches = (agentId: string) => ["agent", agentId, "files"] as const;
const fileContents = (agentId: string) => [...review(agentId), "file"] as const;
/**
 * Content at fixed commits, which never changes: kept apart from `review`, so `git_status` events
 * don't refetch it.
 */
const pinned = (agentId: string) => ["agent", agentId, "pinned"] as const;

export const queryKeys = {
  health: ["health"] as const,
  projects: ["projects"] as const,
  sessions: (cwd?: string) => ["sessions", cwd ?? null] as const,
  sessionSearch: (q: string) => ["sessions", "search", q] as const,
  dirs: (prefix: string) => ["dirs", prefix] as const,
  models: (agentId: string) => ["agent", agentId, "models"] as const,
  thinkingLevels: (agentId: string, modelKey: string) =>
    ["agent", agentId, "thinking-levels", modelKey] as const,
  commands: (agentId: string) => ["agent", agentId, "commands"] as const,
  stats: (agentId: string) => ["agent", agentId, "stats"] as const,
  forkMessages: (agentId: string) => ["agent", agentId, "fork-messages"] as const,
  /** The review panel's diff and open file, invalidated by every `git_status` event. */
  review,
  /** Every `gitDiff` of the agent. */
  gitDiffs,
  gitDiff: (agentId: string, mode: "uncommitted" | "branch", base?: string, uncommitted = false) =>
    [...gitDiffs(agentId), mode, base ?? null, uncommitted] as const,
  /** The PR diff between its pinned commits. */
  prDiff: (agentId: string, baseSha: string, headSha: string) =>
    [...pinned(agentId), "diff", baseSha, headSha] as const,
  gitBranches: (agentId: string) => ["agent", agentId, "branches"] as const,
  /** Every `fileSearch` of the agent. */
  fileSearches,
  fileSearch: (agentId: string, q: string) => [...fileSearches(agentId), q] as const,
  /** Every `fileContent` of the agent's working tree. */
  fileContents,
  /** A file in the working tree, or as committed in `rev`. */
  fileContent: (agentId: string, path: string, rev?: string) =>
    rev === undefined
      ? ([...fileContents(agentId), path] as const)
      : ([...pinned(agentId), "file", path, rev] as const),
};
