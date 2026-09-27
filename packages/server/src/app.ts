import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AgentManager } from "./agents/agent-manager.ts";
import { errorEnvelope, isApiError } from "./errors.ts";
import { agentsRoutes } from "./http/agents-routes.ts";
import { requestGuards } from "./http/guards.ts";
import type { SseOptions } from "./http/sse.ts";
import { spaHandler } from "./http/static.ts";

export interface AppDeps {
  /** Tailnet hostname (Host allowlist, origin checks). */
  hostname: string;
  /** Main listener port (local Host/Origin entries). */
  port: number;
  /** Built SPA directory. */
  staticDir: string;
  manager: AgentManager;
  /** pi's version for `/api/health` (cached by the caller; see `piVersionProbe`). */
  piVersion: () => Promise<string>;
  /** SSE tuning (tests shorten the ping interval). */
  sse?: SseOptions;
}

/** The typed `/api` routes. Chained so `AppType` carries them for the web's `hc` client. */
function apiRoutes(deps: AppDeps) {
  return new Hono()
    .basePath("/api")
    .get("/health", async (c) => c.json({ ok: true as const, piVersion: await deps.piVersion() }))
    .route("/agents", agentsRoutes(deps.manager, deps.sse ? { sse: deps.sse } : {}));
}

/** Builds the Hono app: guards, `/api` routes, error envelope, static SPA. */
export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.use("*", requestGuards({ hostname: deps.hostname, port: deps.port }));
  app.route("/", apiRoutes(deps));
  app.all("/api/*", (c) => c.json(errorEnvelope("not_found", `no route ${c.req.path}`), 404));
  const spa = spaHandler(deps.staticDir);
  app.on(["GET", "HEAD"], "*", spa);
  app.notFound((c) => c.json(errorEnvelope("not_found", `no route ${c.req.path}`), 404));
  app.onError((err, c) => {
    if (isApiError(err)) {
      return c.json(err.toJSON(), err.status as ContentfulStatusCode);
    }
    if (err instanceof HTTPException) {
      // Hono's own 4xx (e.g. malformed JSON from the validator).
      if (err.status >= 400 && err.status < 500) {
        return c.json(errorEnvelope("invalid_body", err.message), err.status);
      }
      return c.json(errorEnvelope("internal", err.message), err.status);
    }
    console.error("[http] unhandled error:", err);
    return c.json(errorEnvelope("internal", "internal server error"), 500);
  });
  return app;
}

export type AppType = ReturnType<typeof apiRoutes>;
