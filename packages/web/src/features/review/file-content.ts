/**
 * A project file's content (`GET …/files/content`), for the Files tab's viewer and the Guide tab's
 * expansion of unchanged lines.
 */

import { useQuery } from "@tanstack/react-query";
import { getFileContent } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import { retryServerErrors } from "./query-states";

/**
 * The working-tree copy of `path` (refetched on every mount), or its content in commit `rev`
 * (never stale: a commit's content doesn't change). Read once `enabled`.
 */
export function useFileContent(agentId: string, path: string, rev?: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.fileContent(agentId, path, rev),
    queryFn: ({ client, queryKey }) =>
      getFileContent(agentId, path, rev, client.getQueryData(queryKey)),
    enabled,
    staleTime: rev === undefined ? 0 : Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: retryServerErrors,
  });
}
