import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  FileContentResponse,
  FileSearchResponse,
  GitBranchesResponse,
  GitDiffResponse,
} from "@pi-code/protocol";
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

/**
 * A GET of `path`, conditional on `etag` when given, accepting `encoding` (`identity` by default;
 * Node's fetch would otherwise send its own `gzip, deflate`).
 */
function get(h: Harness, path: string, etag?: string, encoding = "identity"): Promise<Response> {
  return fetch(`${h.base}${path}`, {
    headers: {
      "Accept-Encoding": encoding,
      ...(etag === undefined ? {} : { "If-None-Match": etag }),
    },
  });
}

/** A 200 with a weak ETag that the browser mustn't store; returns the ETag. */
function fresh(res: Response): string {
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const etag = res.headers.get("etag");
  expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);
  return etag as string;
}

/** A 304 without a body, keeping the ETag and `no-store`. */
async function notModified(res: Response, etag: string): Promise<void> {
  expect(res.status).toBe(304);
  expect(res.headers.get("etag")).toBe(etag);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.text()).toBe("");
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

  it("answers 304 to an unchanged diff and 200 after any working-tree change", async () => {
    const h = await start();
    writeFileSync(join(h.project, "a.txt"), "two\n");
    const agent = await h.open();
    const path = `/api/agents/${agent.id}/git/diff`;

    const first = await get(h, path);
    const etag = fresh(first);
    expect(((await first.json()) as GitDiffResponse).files.map((f) => f.path)).toEqual(["a.txt"]);
    await notModified(await get(h, path, etag), etag);
    // Another query's ETag doesn't match.
    fresh(await get(h, `${path}?base=main`, etag));

    // An edit to an already dirty file: git status stays the same, the diff doesn't.
    writeFileSync(join(h.project, "a.txt"), "three\n");
    const edited = await get(h, path, etag);
    const editedTag = fresh(edited);
    expect(editedTag).not.toBe(etag);
    expect(((await edited.json()) as GitDiffResponse).files[0]?.patch).toContain("+three");
    await notModified(await get(h, path, editedTag), editedTag);

    writeFileSync(join(h.project, "c.txt"), "c\n");
    const added = await get(h, path, editedTag);
    expect(fresh(added)).not.toBe(editedTag);
    expect(((await added.json()) as GitDiffResponse).files.map((f) => f.path)).toEqual([
      "a.txt",
      "c.txt",
    ]);
  });

  it("sends the same weak ETag whether or not the 200 is gzipped, and 304s on either", async () => {
    const h = await start();
    writeFileSync(join(h.project, "a.txt"), "two\n");
    const agent = await h.open();
    const path = `/api/agents/${agent.id}/git/diff`;

    const plain = await get(h, path);
    expect(plain.headers.get("content-encoding")).toBeNull();
    const etag = fresh(plain);
    const gzipped = await get(h, path, undefined, "gzip");
    expect(gzipped.headers.get("content-encoding")).toBe("gzip");
    expect(fresh(gzipped)).toBe(etag);
    expect(((await gzipped.json()) as GitDiffResponse).files.map((f) => f.path)).toEqual(["a.txt"]);
    await notModified(await get(h, path, etag, "gzip"), etag);
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

describe("GET /api/agents/:id/git/branches", () => {
  it("lists local branches with the default", async () => {
    const h = await start();
    const agent = await h.open();
    const res = await h.json<GitBranchesResponse>("GET", `/api/agents/${agent.id}/git/branches`);
    expect(res.status).toBe(200);
    expect(res.body.branches.sort()).toEqual(["feature", "main"]);
    expect(res.body.defaultBranch).toBe("main");
  });

  it("answers 404 outside a work tree", async () => {
    const h = await startHarness();
    harness = h;
    const agent = await h.open();
    const res = await h.json<ErrorEnvelope>("GET", `/api/agents/${agent.id}/git/branches`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_a_git_repo");
  });
});

describe("POST /api/agents/:id/git/fetch", () => {
  it("fetches origin", async () => {
    const h = await start();
    const origin = join(h.root, "origin.git");
    git(h.root, "init", "-q", "--bare", origin);
    git(h.project, "remote", "add", "origin", origin);
    // Pushed by path, so no remote-tracking ref exists until the fetch.
    git(h.project, "push", "-q", origin, "main");
    const agent = await h.open();

    const res = await h.api("POST", `/api/agents/${agent.id}/git/fetch`);
    expect(res.status).toBe(204);
    expect(git(h.project, "rev-parse", "origin/main")).toBe(git(h.project, "rev-parse", "main"));
  });

  it("answers 502 git_failed with git's error without an origin remote", async () => {
    const h = await start();
    const agent = await h.open();
    const res = await h.json<ErrorEnvelope>("POST", `/api/agents/${agent.id}/git/fetch`);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("git_failed");
    expect(res.body.error.message).toMatch(/^git fetch origin failed: .*origin/);
  });

  it("answers 404 outside a work tree", async () => {
    const h = await startHarness();
    harness = h;
    const agent = await h.open();
    const res = await h.json<ErrorEnvelope>("POST", `/api/agents/${agent.id}/git/fetch`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_a_git_repo");
  });
});

describe("GET /api/agents/:id/files", () => {
  it("searches the project's files", async () => {
    const h = await start();
    writeFileSync(join(h.project, "c.txt"), "c\n");
    const agent = await h.open();
    const res = await h.json<FileSearchResponse>("GET", `/api/agents/${agent.id}/files?q=b.t`);
    expect(res.status).toBe(200);
    expect(res.body.files[0]).toBe("b.txt");

    const empty = await h.json<FileSearchResponse>("GET", `/api/agents/${agent.id}/files`);
    expect(empty.body).toEqual({ files: [] });
  });

  it("answers 400 for a query over 200 characters", async () => {
    const h = await start();
    const agent = await h.open();
    const res = await h.json<ErrorEnvelope>(
      "GET",
      `/api/agents/${agent.id}/files?q=${"a".repeat(201)}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_body");
  });

  it("answers 404 outside a work tree", async () => {
    const h = await startHarness();
    harness = h;
    const agent = await h.open();
    const res = await h.json<ErrorEnvelope>("GET", `/api/agents/${agent.id}/files?q=a`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_a_git_repo");
  });
});

describe("GET /api/agents/:id/files/content", () => {
  it("reads a working-tree file", async () => {
    const h = await start();
    writeFileSync(join(h.project, "a.txt"), "edited\n");
    const agent = await h.open();
    const res = await h.json<FileContentResponse>(
      "GET",
      `/api/agents/${agent.id}/files/content?path=${encodeURIComponent("./a.txt")}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      path: "a.txt",
      content: "edited\n",
      binary: false,
      tooLarge: false,
    });
  });

  it("answers 304 to an unchanged file and 200 after it changes", async () => {
    const h = await start();
    const agent = await h.open();
    const path = `/api/agents/${agent.id}/files/content?path=a.txt`;

    const etag = fresh(await get(h, path));
    await notModified(await get(h, path, etag), etag);

    writeFileSync(join(h.project, "a.txt"), "edited\n");
    const edited = await get(h, path, etag);
    expect(fresh(edited)).not.toBe(etag);
    expect(((await edited.json()) as FileContentResponse).content).toBe("edited\n");
  });

  it("answers 404 file_not_found for a missing file and 400 without a path", async () => {
    const h = await start();
    const agent = await h.open();
    const missing = await h.json<ErrorEnvelope>(
      "GET",
      `/api/agents/${agent.id}/files/content?path=nope.txt`,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("file_not_found");

    const noPath = await h.json<ErrorEnvelope>("GET", `/api/agents/${agent.id}/files/content`);
    expect(noPath.status).toBe(400);
    expect(noPath.body.error.code).toBe("invalid_body");
  });

  it("answers 404 outside a work tree", async () => {
    const h = await startHarness();
    harness = h;
    writeFileSync(join(h.project, "a.txt"), "a\n");
    const agent = await h.open();
    const res = await h.json<ErrorEnvelope>(
      "GET",
      `/api/agents/${agent.id}/files/content?path=a.txt`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_a_git_repo");
  });
});
