import { isAbsolute } from "node:path";
import type { CreateWorktreeBody, RemoveWorktreeBody } from "@pi-code/protocol";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type { Agent, AgentManager } from "../agents/agent-manager.ts";
import { layoutOf, mainCheckoutIn } from "../catalog/layout.ts";
import { deleteSessionFiles } from "../catalog/session-files.ts";
import type { SessionCatalog } from "../catalog/sessions.ts";
import { ApiError, isApiError } from "../errors.ts";
import { assertClean, createWorktree, removeWorktree } from "../git/worktrees.ts";
import type { StreamHub } from "../live/stream-hub.ts";
import { canonicalPath, isInside } from "../paths.ts";

interface WorktreesDeps {
  manager: AgentManager;
  catalog: SessionCatalog;
  hub: StreamHub;
  /** Moves a file to the Trash (default `trash`). */
  trashCommand?: string;
}

function parseCreateBody(value: unknown): CreateWorktreeBody {
  if (typeof value === "object" && value !== null) {
    const { repo, name, branch, base } = value as Record<string, unknown>;
    if (
      typeof repo === "string" &&
      typeof name === "string" &&
      (branch === undefined || typeof branch === "string") &&
      (base === undefined || typeof base === "string")
    ) {
      if (!isAbsolute(repo)) throw new ApiError("invalid_body", "repo must be an absolute path");
      return {
        repo,
        name,
        ...(branch === undefined ? {} : { branch }),
        ...(base === undefined ? {} : { base }),
      };
    }
  }
  throw new ApiError(
    "invalid_body",
    "expected { repo: string, name: string, branch?: string, base?: string }",
  );
}

function parseRemoveBody(value: unknown): RemoveWorktreeBody {
  if (typeof value === "object" && value !== null) {
    const { path, force } = value as Record<string, unknown>;
    if (typeof path === "string" && (force === undefined || typeof force === "boolean")) {
      if (!isAbsolute(path)) throw new ApiError("invalid_body", "path must be an absolute path");
      return force === undefined ? { path } : { path, force };
    }
  }
  throw new ApiError("invalid_body", "expected { path: string, force?: boolean }");
}

/** Opens the conversation in a just-created worktree; a failure says the worktree exists. */
async function openIn(manager: AgentManager, path: string): Promise<Agent> {
  try {
    return await manager.open({ cwd: path });
  } catch (e) {
    const created = `the worktree was created at ${path}`;
    if (isApiError(e)) throw new ApiError(e.code, `${e.message} (${created})`);
    console.error(`[worktrees] opening ${path} failed:`, e);
    throw new ApiError("internal", `could not open a conversation (${created})`);
  }
}

/** Closes every agent, exited ones included, whose cwd is inside `path`. */
async function closeAgentsIn(manager: AgentManager, path: string): Promise<void> {
  const ids = manager
    .list()
    .filter((a) => isInside(path, a.cwd))
    .map((a) => a.id);
  await Promise.all(
    ids.map((id) =>
      manager.close(id).catch((e: unknown) => {
        if (!isApiError(e, "agent_not_found")) throw e; // closed meanwhile
      }),
    ),
  );
}

/** Deletes the sessions whose header cwd is inside `path`; `internal` naming any survivors. */
async function deleteSessionsIn(
  catalog: SessionCatalog,
  path: string,
  trashCommand: string | undefined,
): Promise<void> {
  catalog.invalidate();
  const files = (await catalog.sessions())
    .filter((s) => isAbsolute(s.cwd) && isInside(path, s.cwd))
    .map((s) => s.file);
  const failed = await deleteSessionFiles(files, trashCommand);
  if (failed.length > 0) {
    throw new ApiError("internal", `could not delete session files: ${failed.join(", ")}`);
  }
}

/** `/api/worktrees` routes. Chained so the route types reach `AppType`. */
export function worktreesRoutes({ manager, catalog, hub, trashCommand }: WorktreesDeps) {
  return new Hono()
    .post(
      "/",
      validator("json", (value) => parseCreateBody(value)),
      async (c) => {
        const path = await createWorktree({ home: manager.home, ...c.req.valid("json") });
        const agent = await openIn(manager, path);
        return c.json({ agent: agent.info() }, 201);
      },
    )
    .delete(
      "/",
      validator("json", (value) => parseRemoveBody(value)),
      async (c) => {
        const body = c.req.valid("json");
        const force = body.force ?? false;
        const path = await canonicalPath(body.path, manager.home);
        const layout = layoutOf(path);
        const main = layout?.role === "worktree" ? mainCheckoutIn(layout.repo) : undefined;
        if (main === undefined) {
          throw new ApiError("not_a_worktree", `${path} is not a linked worktree`);
        }
        // Checked before closing anything, so conversations keep running if the user cancels.
        if (!force) await assertClean(path);
        // A running pi would recreate its session file after the deletion below.
        await closeAgentsIn(manager, path);
        await removeWorktree(main, path, force);
        try {
          await deleteSessionsIn(catalog, path, trashCommand);
        } finally {
          await hub.refreshCatalog();
        }
        return c.body(null, 204);
      },
    );
}
