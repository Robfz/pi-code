import { Hono } from "hono";
import { listDirs } from "../catalog/dirs.ts";
import type { SessionCatalog } from "../catalog/sessions.ts";

/** `/api/projects`, `/api/sessions`, `/api/fs/dirs`. Chained so the route types reach `AppType`. */
export function catalogRoutes(catalog: SessionCatalog, home: string) {
  return new Hono()
    .get("/projects", async (c) => c.json({ projects: await catalog.projects() }, 200))
    .get("/sessions", async (c) => {
      const cwd = c.req.query("cwd");
      return c.json({ sessions: await catalog.sessions(cwd || undefined) }, 200);
    })
    .get("/fs/dirs", async (c) => {
      const dirs = await listDirs(c.req.query("prefix") ?? "", {
        home,
        sessionCwds: () => catalog.sessionCwds(),
      });
      return c.json({ dirs }, 200);
    });
}
