/**
 * The Files tab (`docs/design/07-code-review.md`, "Files tab"): a debounced fuzzy search over the
 * project's files, or the viewer once a file is open. The query and the open file live in the
 * review state, so they survive switching tabs and going back from the viewer.
 */

import { useQuery } from "@tanstack/react-query";
import { FileIcon } from "lucide-react";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { errorMessage, isApiRequestError, searchFiles } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { FileViewer } from "./file-viewer";
import { NotARepo, retryServerErrors } from "./query-states";
import { useReview, useReviewStore } from "./review-state";

/** Delay before the search field queries `GET files`. */
export const FILE_SEARCH_DEBOUNCE_MS = 250;

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { name: path, dir: "" }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

function FileSearch({ agentId, query }: { agentId: string; query: string }) {
  const q = useDebouncedValue(query.trim(), FILE_SEARCH_DEBOUNCE_MS);
  const search = useQuery({
    queryKey: queryKeys.fileSearch(agentId, q),
    queryFn: () => searchFiles(agentId, q),
    enabled: q !== "",
    refetchOnWindowFocus: false,
    retry: retryServerErrors,
    placeholderData: (previous) => previous,
  });

  if (isApiRequestError(search.error, "not_a_git_repo")) return <NotARepo />;

  const files = q === "" ? [] : (search.data ?? []);
  let status: string | null = null;
  if (query.trim() === "") status = "Type to search files";
  else if (search.isError) status = `Couldn't search the files: ${errorMessage(search.error)}`;
  else if (q !== "" && search.isSuccess && !search.isPlaceholderData && files.length === 0)
    status = "No matching files";

  return (
    <Command shouldFilter={false} label="Search files" className="rounded-none! bg-transparent p-0">
      <CommandInput
        aria-label="Search files"
        placeholder="Search files"
        value={query}
        onValueChange={(value) => useReviewStore.getState().setFilesQuery(agentId, value)}
        className="text-base md:text-sm"
      />
      <CommandList aria-label="Files" className="max-h-none">
        {status === null &&
          files.map((path) => {
            const { name, dir } = splitPath(path);
            return (
              <CommandItem
                key={path}
                value={path}
                onSelect={() => useReviewStore.getState().openFile(agentId, path)}
                className="min-w-0"
              >
                <FileIcon className="text-muted-foreground" />
                <span className="min-w-0 truncate">
                  <span>{name}</span>
                  {dir && <span className="ml-2 text-xs text-muted-foreground">{dir}</span>}
                </span>
              </CommandItem>
            );
          })}
      </CommandList>
      {status !== null && (
        <p className="py-10 text-center text-sm text-muted-foreground">{status}</p>
      )}
    </Command>
  );
}

export function FilesView({ agentId, onAdded }: { agentId: string; onAdded?(): void }) {
  const { files } = useReview(agentId);
  if (files.path !== undefined) {
    return (
      <FileViewer
        agentId={agentId}
        path={files.path}
        {...(files.target && { target: files.target })}
        onBack={() => useReviewStore.getState().closeFile(agentId)}
        {...(onAdded && { onAdded })}
      />
    );
  }
  return <FileSearch agentId={agentId} query={files.query} />;
}
