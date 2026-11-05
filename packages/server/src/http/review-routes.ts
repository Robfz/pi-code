import type { FileSearchResponse } from "@pi-code/protocol";
import { Hono, type MiddlewareHandler } from "hono";
import { etag } from "hono/etag";
import type { AgentManager } from "../agents/agent-manager.ts";
import { ApiError } from "../errors.ts";
import { readFileAtRev, readProjectFile, searchFiles } from "../git/files.ts";
import { gitDiff, requireWorkTree } from "../git/git.ts";
import { fetchOrigin, listBranches } from "../git/refs.ts";
import type { PrStore } from "../store/pr-store.ts";

/**
 * The review panel refetches its diff and open file after every git refresh, mostly unchanged.
 * Each response carries a weak `ETag` (a hash of its JSON), and a request whose `If-None-Match`
 * matches it gets a 304 without a body. Weak because `compress()` weakens the tag of every 200 it
 * encodes, and the 304, which it doesn't encode, must send the same tag. `no-store` keeps the
 * browser's own cache out of it: only the client's last response is ever reused, and only on a
 * 304.
 */
const noStore: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
};
const conditional = etag({ weak: true });

/**
 * The review panel's routes (design/07-code-review.md, design/10-pr-review.md), mounted at
 * `/api/agents`. Chained so the route types reach `AppType`.
 */
export function reviewRoutes(manager: AgentManager, prs: PrStore) {
  return new Hono()
    .get("/:id/git/diff", noStore, conditional, async (c) => {
      const agent = manager.require(c.req.param("id"));
      if (c.req.query("pr") === "1") {
        const file = agent.sessionFile;
        const pr = file === undefined ? undefined : prs.get(file);
        if (pr === undefined) {
          throw new ApiError("invalid_body", "this conversation isn't attached to a PR");
        }
        return c.json(
          await gitDiff(agent.cwd, { range: { from: pr.baseSha, to: pr.headSha } }),
          200,
        );
      }
      const base = c.req.query("base");
      const uncommitted = c.req.query("uncommitted") === "1";
      return c.json(await gitDiff(agent.cwd, base === undefined ? {} : { base, uncommitted }), 200);
    })
    .get("/:id/git/branches", async (c) => {
      const agent = manager.require(c.req.param("id"));
      return c.json(await listBranches(agent.cwd), 200);
    })
    .post("/:id/git/fetch", async (c) => {
      const agent = manager.require(c.req.param("id"));
      await requireWorkTree(agent.cwd);
      await fetchOrigin(agent.cwd);
      return c.body(null, 204);
    })
    .get("/:id/files", async (c) => {
      const agent = manager.require(c.req.param("id"));
      const body: FileSearchResponse = {
        files: await searchFiles(agent.cwd, c.req.query("q") ?? ""),
      };
      return c.json(body, 200);
    })
    .get("/:id/files/content", noStore, conditional, async (c) => {
      const agent = manager.require(c.req.param("id"));
      const path = c.req.query("path");
      if (!path) throw new ApiError("invalid_body", "path is required");
      const rev = c.req.query("rev");
      const file =
        rev === undefined
          ? await readProjectFile(agent.cwd, path)
          : await readFileAtRev(agent.cwd, path, rev);
      return c.json(file, 200);
    });
}
