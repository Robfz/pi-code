import type { OpenAgentBody } from "@pi-code/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import type { AgentManager } from "../agents/agent-manager.ts";
import {
  assertAcceptsInput,
  parseRpcCommand,
  parseUiResponse,
  runCommand,
} from "../agents/commands.ts";
import { ApiError, errorEnvelope } from "../errors.ts";
import { eventStream, type SseOptions } from "./sse.ts";

/** `prompt.images` are base64: allow large bodies on `/rpc`. */
const RPC_BODY_LIMIT = 25 * 1024 * 1024;

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

export interface AgentsRoutesOptions {
  sse?: SseOptions;
}

/** `/api/agents` routes. Chained so the route types reach `AppType`. */
export function agentsRoutes(manager: AgentManager, opts: AgentsRoutesOptions = {}) {
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
    })
    .get("/:id/snapshot", (c) => {
      const pipeline = manager.require(c.req.param("id")).pipeline;
      pipeline.setAttention("none");
      return c.json(pipeline.snapshot(), 200);
    })
    .post("/:id/ack", (c) => {
      manager.require(c.req.param("id")).pipeline.setAttention("none");
      return c.body(null, 204);
    })
    .get("/:id/events", (c) => {
      const agent = manager.require(c.req.param("id"));
      return eventStream(c, agent.pipeline.log, opts.sse);
    })
    .post(
      "/:id/rpc",
      bodyLimit({
        maxSize: RPC_BODY_LIMIT,
        onError: (c) => c.json(errorEnvelope("invalid_body", "request body too large"), 400),
      }),
      validator("json", (value) => parseRpcCommand(value)),
      async (c) => {
        const agent = manager.require(c.req.param("id"));
        const outcome = await runCommand(agent, c.req.valid("json"), {
          ownerOf: (file, except) => manager.ownerOf(file, except),
        });
        return outcome.status === 202
          ? c.json({ data: outcome.data }, 202)
          : c.json({ data: outcome.data }, 200);
      },
    )
    .post(
      "/:id/ui-responses",
      validator("json", (value) => parseUiResponse(value)),
      (c) => {
        const agent = manager.require(c.req.param("id"));
        assertAcceptsInput(agent);
        agent.pipeline.answerDialog(c.req.valid("json"));
        return c.body(null, 204);
      },
    );
}
