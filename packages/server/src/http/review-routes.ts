import { Hono } from "hono";
import type { AgentManager } from "../agents/agent-manager.ts";
import { gitDiff } from "../git/git.ts";

/**
 * The review panel's routes (design/07-code-review.md), mounted at `/api/agents`. Chained so the
 * route types reach `AppType`.
 */
export function reviewRoutes(manager: AgentManager) {
  return new Hono().get("/:id/git/diff", async (c) => {
    const agent = manager.require(c.req.param("id"));
    const base = c.req.query("base");
    const uncommitted = c.req.query("uncommitted") === "1";
    return c.json(await gitDiff(agent.cwd, base === undefined ? {} : { base, uncommitted }), 200);
  });
}
