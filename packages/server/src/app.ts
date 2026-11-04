import { Hono } from "hono";
import { compress } from "hono/compress";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AgentManager } from "./agents/agent-manager.ts";
import type { SessionCatalog } from "./catalog/sessions.ts";
import { errorEnvelope, isApiError } from "./errors.ts";
import { agentsRoutes } from "./http/agents-routes.ts";
import { catalogRoutes } from "./http/catalog-routes.ts";
import { requestGuards } from "./http/guards.ts";
import { prRoutes } from "./http/pr-routes.ts";
import { pushRoutes } from "./http/push-routes.ts";
import { reviewRoutes } from "./http/review-routes.ts";
import { sessionsRoutes } from "./http/sessions-routes.ts";
import { sidebarRoutes } from "./http/sidebar-routes.ts";
import { spaHandler } from "./http/static.ts";
import { type SseOptions, streamRoutes } from "./http/stream.ts";
import { worktreesRoutes } from "./http/worktrees-routes.ts";
import type { StreamHub } from "./live/stream-hub.ts";
import type { PrService } from "./pr/pr-service.ts";
import type { PushService } from "./push/push-service.ts";
import type { SidebarStateStore } from "./store/sidebar-state.ts";

interface AppDeps {
  /** Tailnet hostname (Host allowlist, origin checks). */
  hostname: string;
  /** Main listener port (local Host/Origin entries). */
  port: number;
  /** Built SPA directory. */
  staticDir: string;
  manager: AgentManager;
  /** Sessions and projects; deletes files only through `session-files.ts` (session deletion, worktree removal). */
  catalog: SessionCatalog;
  /** Shared inputs of `GET /api/stream`. */
  hub: StreamHub;
  /** Pins and collapsed groups (`PATCH /api/sidebar`); the hub broadcasts its changes. */
  sidebar: SidebarStateStore;
  /** PR review (`/api/agents/:id/pr…`); the hub broadcasts its store's changes. */
  prService: PrService;
  /** pi's version for `/api/health` (cached by the caller; see `piVersionProbe`). */
  piVersion: () => Promise<string>;
  /** Web Push (routes answer `not_found` without it). */
  push?: PushService;
  /** SSE tuning (tests shorten the ping interval). */
  sse?: SseOptions;
  /** Moves session files to the Trash on deletion and worktree removal (default `trash`). */
  trashCommand?: string;
}

/** The typed `/api` routes. Chained so `AppType` carries them for the web's `hc` client. */
function apiRoutes(deps: AppDeps) {
  const writeDeps = {
    manager: deps.manager,
    catalog: deps.catalog,
    hub: deps.hub,
    ...(deps.trashCommand !== undefined ? { trashCommand: deps.trashCommand } : {}),
  };
  return new Hono()
    .basePath("/api")
    .get("/health", async (c) => c.json({ ok: true as const, piVersion: await deps.piVersion() }))
    .route("/", catalogRoutes(deps.catalog, deps.manager.home))
    .route("/sessions", sessionsRoutes(writeDeps))
    .route(
      "/agents",
      agentsRoutes(deps.manager, {
        onSessionCopied: (from, to) => deps.prService.store.copy(from, to),
      }),
    )
    .route("/agents", reviewRoutes(deps.manager, deps.prService.store))
    .route("/agents", prRoutes(deps.manager, deps.prService))
    .route("/worktrees", worktreesRoutes(writeDeps))
    .route("/sidebar", sidebarRoutes(deps.sidebar))
    .route("/stream", streamRoutes(deps.manager, deps.hub, deps.sse))
    .route("/push", pushRoutes(deps.push));
}

/** Builds the Hono app: guards, compressed JSON, `/api` routes, error envelope, static SPA. */
export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.use("*", requestGuards({ hostname: deps.hostname, port: deps.port }));
  // JSON only: compressing `text/event-stream` would buffer `/api/stream`'s frames. `c.json`
  // sets no Content-Length, so the size threshold never applies and even tiny bodies are gzipped;
  // that costs a few bytes and microseconds, which isn't worth buffering every body to measure.
  app.use("/api/*", compress({ contentTypeFilter: /^application\/json(?:[;\s]|$)/i }));
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
