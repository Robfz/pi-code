import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LoaderIcon } from "lucide-react";
import { HomeBackButton } from "@/components/home-back-button";
import { Button } from "@/components/ui/button";
import { errorMessage, listProjects, listSessions } from "@/lib/api";
import { baseName } from "@/lib/content";
import { queryKeys } from "@/lib/query-client";
import { ScreenHeader } from "@/routes/placeholder";
import { GroupedSessionList } from "./session-list";

/** `/sessions`: all sessions, filterable by project (`?cwd=`), in listing groups. */
export function SessionsScreen({ cwd }: { cwd?: string }) {
  const navigate = useNavigate();
  const projects = useQuery({ queryKey: queryKeys.projects, queryFn: listProjects });
  const sessions = useQuery({
    queryKey: queryKeys.sessions(cwd),
    queryFn: () => listSessions(cwd),
  });
  const projectOptions = projects.data?.map((p) => p.cwd) ?? [];
  if (cwd && !projectOptions.includes(cwd)) projectOptions.unshift(cwd);

  return (
    <div className="flex min-h-dvh w-full flex-col">
      <ScreenHeader>
        <HomeBackButton />
        <h1 className="truncate text-sm font-medium">Sessions</h1>
      </ScreenHeader>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-4 pb-8">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Project
          <select
            aria-label="Project"
            value={cwd ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              void navigate({ to: "/sessions", search: value ? { cwd: value } : {} });
            }}
            className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-base text-foreground md:text-sm"
          >
            <option value="">All projects</option>
            {projectOptions.map((path) => (
              <option key={path} value={path}>
                {baseName(path)} — {path}
              </option>
            ))}
          </select>
        </label>
        {sessions.isPending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" /> Loading…
          </p>
        )}
        {sessions.isError && (
          <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
            {errorMessage(sessions.error)}
            <Button variant="outline" size="sm" onClick={() => void sessions.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {sessions.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {cwd
              ? "No sessions in this project yet."
              : "No sessions yet — start a new conversation from Home."}
          </p>
        )}
        {sessions.data && sessions.data.length > 0 && (
          <GroupedSessionList sessions={sessions.data} />
        )}
      </div>
    </div>
  );
}
