import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SidebarResponse } from "@pi-code/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ErrorEnvelope } from "../errors.ts";
import { type Harness, startHarness } from "../testing/http-harness.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("PATCH /api/sidebar", () => {
  it("sets flags, answers the state and streams it to every client", async () => {
    const h = await startHarness();
    harness = h;
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    const client = h.stream();
    const baseline = await client.waitFor((f) => f.type === "baseline");
    expect(baseline).toMatchObject({ sidebar: { pinned: [], collapsed: [] } });

    const res = await h.json<SidebarResponse>("PATCH", "/api/sidebar", {
      pinned: { [repo]: true },
      collapsed: { [h.project]: true },
    });
    expect(res).toEqual({
      status: 200,
      body: { sidebar: { pinned: [repo], collapsed: [h.project] } },
    });
    expect(await client.waitFor((f) => f.type === "sidebar")).toEqual({
      type: "sidebar",
      sidebar: { pinned: [repo], collapsed: [h.project] },
    });

    // A later connection gets it in its baseline.
    const later = h.stream();
    expect(await later.waitFor((f) => f.type === "baseline")).toMatchObject({
      sidebar: { pinned: [repo], collapsed: [h.project] },
    });
  });

  it("rejects malformed bodies", async () => {
    const h = await startHarness();
    harness = h;
    const res = await h.json<ErrorEnvelope>("PATCH", "/api/sidebar", { pinned: { x: true } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_body");
  });
});
