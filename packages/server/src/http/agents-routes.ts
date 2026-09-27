import { Hono } from "hono";
import { validator } from "hono/validator";
import type { AgentManager } from "../agents/agent-manager.ts";
import { ApiError } from "../errors.ts";

export type OpenAgentBody = { cwd: string } | { sessionFile: string };

function parseOpenBody(value: unknown): OpenAgentBody {
  if (typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    if (typeof v.cwd === "string" && v.sessionFile === undefined) return { cwd: v.cwd };
    if (typeof v.sessionFile === "string" && v.cwd === undefined) {
      return { sessionFile: v.sessionFile };
    }
  }
  throw new ApiError("invalid_body", "expected { cwd: string } or { sessionFile: string }");
}

/** `/api/agents` routes. Chained so the route types reach `AppType`. */
export function agentsRoutes(manager: AgentManager) {
  return new Hono()
    .get("/", (c) => c.json({ agents: manager.list() }, 200))
    .post(
      "/",
      validator("json", (value) => parseOpenBody(value)),
      async (c) => {
        const body = c.req.valid("json");
        if (!("cwd" in body)) {
          // Resuming a session file lands with the full lifecycle (S10).
          throw new ApiError("invalid_body", "opening a sessionFile is not supported yet");
        }
        const agent = await manager.open({ cwd: body.cwd });
        return c.json({ agent: agent.info() }, 201);
      },
    )
    .get("/:id", (c) => c.json({ agent: manager.require(c.req.param("id")).info() }, 200))
    .delete("/:id", async (c) => {
      await manager.close(c.req.param("id"));
      return c.body(null, 204);
    });
}
