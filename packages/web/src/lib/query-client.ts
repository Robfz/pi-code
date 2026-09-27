import { QueryClient } from "@tanstack/react-query";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: true },
    },
  });
}

export const queryKeys = {
  agents: ["agents"] as const,
  health: ["health"] as const,
  projects: ["projects"] as const,
  sessions: (cwd?: string) => ["sessions", cwd ?? null] as const,
  dirs: (prefix: string) => ["dirs", prefix] as const,
  models: (agentId: string) => ["agent", agentId, "models"] as const,
  thinkingLevels: (agentId: string, modelKey: string) =>
    ["agent", agentId, "thinking-levels", modelKey] as const,
  commands: (agentId: string) => ["agent", agentId, "commands"] as const,
  stats: (agentId: string) => ["agent", agentId, "stats"] as const,
  forkMessages: (agentId: string) => ["agent", agentId, "fork-messages"] as const,
  tree: (agentId: string, version: string) => ["agent", agentId, "tree", version] as const,
};
