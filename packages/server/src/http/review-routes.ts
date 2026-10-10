import type { FileSearchResponse } from "@pi-code/protocol";
import { Hono } from "hono";
import type { AgentManager } from "../agents/agent-manager.ts";
import { ApiError } from "../errors.ts";
import { readProjectFile, searchFiles } from "../git/files.ts";
import { gitDiff } from "../git/git.ts";
import { listBranches } from "../git/refs.ts";

/**
 * The review panel's routes (design/07-code-review.md), mounted at `/api/agents`. Chained so the
 * route types reach `AppType`.
 */
export function reviewRoutes(manager: AgentManager) {
  return new Hono()
    .get("/:id/git/diff", async (c) => {
      const agent = manager.require(c.req.param("id"));
      const base = c.req.query("base");
      const uncommitted = c.req.query("uncommitted") === "1";
      return c.json(await gitDiff(agent.cwd, base === undefined ? {} : { base, uncommitted }), 200);
    })
    .get("/:id/git/branches", async (c) => {
      const agent = manager.require(c.req.param("id"));
      return c.json(await listBranches(agent.cwd), 200);
    })
    .get("/:id/files", async (c) => {
      const agent = manager.require(c.req.param("id"));
      const body: FileSearchResponse = {
        files: await searchFiles(agent.cwd, c.req.query("q") ?? ""),
      };
      return c.json(body, 200);
    })
    .get("/:id/files/content", async (c) => {
      const agent = manager.require(c.req.param("id"));
      const path = c.req.query("path");
      if (!path) throw new ApiError("invalid_body", "path is required");
      return c.json(await readProjectFile(agent.cwd, path), 200);
    });
}
