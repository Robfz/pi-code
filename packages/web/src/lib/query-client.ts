import { QueryClient } from "@tanstack/react-query";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: true },
    },
  });
}

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
  review: (agentId: string) => ["agent", agentId, "review"] as const,
  gitDiff: (agentId: string, mode: "uncommitted" | "branch", base?: string, uncommitted = false) =>
    ["agent", agentId, "review", "diff", mode, base ?? null, uncommitted] as const,
  gitBranches: (agentId: string) => ["agent", agentId, "branches"] as const,
  fileSearch: (agentId: string, q: string) => ["agent", agentId, "files", q] as const,
  fileContent: (agentId: string, path: string) =>
    ["agent", agentId, "review", "file", path] as const,
};
