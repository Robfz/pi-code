import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitDiffResponse } from "@pi-code/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ErrorEnvelope } from "../errors.ts";
import { type Harness, startHarness } from "../testing/http-harness.ts";
import { git } from "../testing/layout-repo.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A harness whose project is a repo on `feature`, one commit ahead of `main`. */
async function start(): Promise<Harness> {
  const h = await startHarness();
  harness = h;
  git(h.project, "init", "-q", "-b", "main");
  writeFileSync(join(h.project, "a.txt"), "one\n");
  git(h.project, "add", ".");
  git(h.project, "commit", "-qm", "main");
  git(h.project, "checkout", "-q", "-b", "feature");
  writeFileSync(join(h.project, "b.txt"), "b\n");
  git(h.project, "add", ".");
  git(h.project, "commit", "-qm", "feature");
  return h;
}

describe("GET /api/agents/:id/git/diff", () => {
  it("diffs the working tree against HEAD, or a branch's merge-base", async () => {
    const h = await start();
    writeFileSync(join(h.project, "a.txt"), "two\n");
    writeFileSync(join(h.project, "c.txt"), "c\n");
    const agent = await h.open();
    const head = git(h.project, "rev-parse", "--short", "HEAD").trim();
    const mergeBase = git(h.project, "rev-parse", "--short", "main").trim();

    const plain = await h.json<GitDiffResponse>("GET", `/api/agents/${agent.id}/git/diff`);
    expect(plain.status).toBe(200);
    expect(plain.body.oldRev).toBe(head);
    expect(plain.body.files.map((f) => f.path)).toEqual(["a.txt", "c.txt"]);

    const committed = await h.json<GitDiffResponse>(
      "GET",
      `/api/agents/${agent.id}/git/diff?base=main`,
    );
    expect(committed.body).toMatchObject({ oldRev: mergeBase, newRev: head });
    expect(committed.body.files.map((f) => f.path)).toEqual(["b.txt"]);

    const all = await h.json<GitDiffResponse>(
      "GET",
      `/api/agents/${agent.id}/git/diff?base=main&uncommitted=1`,
    );
    expect(all.status).toBe(200);
    expect(all.body.oldRev).toBe(mergeBase);
    expect(all.body.newRev).toBeUndefined();
    expect(all.body.files.map((f) => f.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("answers 400 for an unknown base", async () => {
    const h = await start();
    const agent = await h.open();
    const res = await h.json<ErrorEnvelope>("GET", `/api/agents/${agent.id}/git/diff?base=nope`);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "invalid_body", message: "unknown branch nope" });
  });

  it("answers 404 outside a work tree", async () => {
    const h = await startHarness();
    harness = h;
    const agent = await h.open();
    const res = await h.json<ErrorEnvelope>("GET", `/api/agents/${agent.id}/git/diff`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_a_git_repo");
  });
});
