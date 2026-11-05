import type { OpenAgentBody, TrustBody } from "@pi-code/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import type { AgentManager } from "../agents/agent-manager.ts";
import {
  assertAcceptsInput,
  navigateTree,
  parseNavigateBody,
  parseRpcCommand,
  parseUiResponse,
  runCommand,
} from "../agents/commands.ts";
import { ApiError, errorEnvelope } from "../errors.ts";
import { gitStatus } from "../git/git.ts";

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

function parseTrustBody(value: unknown): TrustBody {
  if (typeof value === "object" && value !== null) {
    const trusted = (value as Record<string, unknown>).trusted;
    if (typeof trusted === "boolean") return { trusted };
  }
  throw new ApiError("invalid_body", "expected { trusted: boolean }");
}

interface AgentsRoutesDeps {
  /** A `clone` copied session `from` to `to` (PR attachments follow). */
  onSessionCopied?(from: string, to: string): Promise<void>;
  /** Whether `sessionFile` has a PR attachment (no tree navigation or fork then). */
  isPrAttached?(sessionFile: string): boolean;
}

/** `/api/agents` routes. Chained so the route types reach `AppType`. */
export function agentsRoutes(manager: AgentManager, deps: AgentsRoutesDeps = {}) {
  return new Hono()
    .get("/", (c) => c.json({ agents: manager.list() }, 200))
    .post(
      "/",
      validator("json", (value) => parseOpenBody(value)),
      async (c) => {
        const body = c.req.valid("json");
        if ("sessionFile" in body) {
          const { agent, existing } = await manager.openSession(body.sessionFile);
          return existing
            ? c.json({ agent: agent.info() }, 200)
            : c.json({ agent: agent.info() }, 201);
        }
        const agent = await manager.open({ cwd: body.cwd });
        return c.json({ agent: agent.info() }, 201);
      },
    )
    .get("/:id", (c) => c.json({ agent: manager.require(c.req.param("id")).info() }, 200))
    .post(
      "/:id/trust",
      validator("json", (value) => parseTrustBody(value)),
      (c) => {
        const agent = manager.trust(c.req.param("id"), c.req.valid("json").trusted);
        return c.json({ agent: agent.info() }, 200);
      },
    )
    .post("/:id/restart", async (c) => {
      const agent = await manager.restart(c.req.param("id"));
      return c.json({ agent: agent.info() }, 200);
    })
    .post(
      "/:id/tree/navigate",
      validator("json", (value) => parseNavigateBody(value)),
      async (c) => {
        const agent = manager.require(c.req.param("id"));
        return c.json(await navigateTree(agent, c.req.valid("json"), deps.isPrAttached), 200);
      },
    )
    .get("/:id/git/status", async (c) => {
      const agent = manager.require(c.req.param("id"));
      return c.json({ status: await gitStatus(agent.cwd) }, 200);
    })
    .delete("/:id", async (c) => {
      await manager.close(c.req.param("id"));
      return c.body(null, 204);
    })
    .get("/:id/snapshot", (c) =>
      c.json(manager.require(c.req.param("id")).pipeline.snapshot(), 200),
    )
    .post("/:id/ack", (c) => {
      manager.require(c.req.param("id")).pipeline.ack();
      return c.body(null, 204);
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
          resolveSessionFile: (file) => manager.resolveSessionFile(file),
          ...(deps.onSessionCopied && { onSessionCopied: deps.onSessionCopied }),
          ...(deps.isPrAttached && { isPrAttached: deps.isPrAttached }),
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
