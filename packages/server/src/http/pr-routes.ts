import type { AttachPrBody } from "@pi-code/protocol";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type { AgentManager } from "../agents/agent-manager.ts";
import { ApiError } from "../errors.ts";
import type { PrService } from "../pr/pr-service.ts";

function parseAttachBody(value: unknown): AttachPrBody {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const pr = (value as Record<string, unknown>).pr;
    if (keys.every((key) => key === "pr") && (pr === undefined || typeof pr === "string")) {
      return pr === undefined ? {} : { pr };
    }
  }
  throw new ApiError("invalid_body", "expected { pr?: string }");
}

/**
 * PR review's routes (design/10-pr-review.md), mounted at `/api/agents`. Chained so the route
 * types reach `AppType`.
 */
export function prRoutes(manager: AgentManager, service: PrService) {
  return new Hono()
    .post(
      "/:id/pr",
      validator("json", (value) => parseAttachBody(value)),
      async (c) => {
        const agent = manager.require(c.req.param("id"));
        return c.json({ pr: await service.attach(agent, c.req.valid("json").pr ?? "") }, 200);
      },
    )
    .post("/:id/pr/refresh", async (c) => {
      const agent = manager.require(c.req.param("id"));
      return c.json(await service.refresh(agent), 200);
    })
    .post("/:id/pr/poll", async (c) => {
      await service.poll(manager.require(c.req.param("id")));
      return c.body(null, 204);
    })
    .get("/:id/pr/guide", async (c) => {
      return c.json(await service.guide(manager.require(c.req.param("id"))), 200);
    })
    .post("/:id/pr/guide/retry", async (c) => {
      return c.json(await service.retryGuide(manager.require(c.req.param("id"))), 200);
    });
}
