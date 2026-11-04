import { describe, expect, it } from "vitest";
import { isApiError } from "../errors.ts";
import {
  GhError,
  type GhRunner,
  inlineComments,
  parseGithubRemote,
  parsePrArg,
  parsePrUrl,
  sameRepo,
  viewPr,
} from "./github.ts";

describe("parseGithubRemote", () => {
  it.each([
    ["git@github.com:octo/repo.git", "octo/repo"],
    ["git@github.com:octo/repo", "octo/repo"],
    ["github.com:octo/repo.git", "octo/repo"],
    ["ssh://git@github.com/octo/repo.git", "octo/repo"],
    ["ssh://git@github.com:22/octo/repo", "octo/repo"],
    ["https://github.com/octo/repo.git", "octo/repo"],
    ["https://github.com/octo/repo", "octo/repo"],
    ["https://github.com/octo/repo/", "octo/repo"],
    ["https://user@github.com/octo/my.repo.git", "octo/my.repo"],
    ["git://github.com/octo/repo.git", "octo/repo"],
  ])("reads %s", (url, repo) => {
    expect(parseGithubRemote(url)).toBe(repo);
  });

  it.each([
    "git@gitlab.com:octo/repo.git",
    "https://github.com/octo",
    "https://github.com/octo/repo/tree/main",
    "https://notgithub.com/octo/repo",
    "/srv/git/repo.git",
  ])("rejects %s", (url) => {
    expect(parseGithubRemote(url)).toBeUndefined();
  });
});

describe("parsePrUrl", () => {
  it("reads a PR URL's repo and number", () => {
    expect(parsePrUrl("https://github.com/octo/repo/pull/12")).toEqual({
      repo: "octo/repo",
      number: 12,
    });
    expect(parsePrUrl("https://www.github.com/o/r.js/pull/3/files?w=1")).toEqual({
      repo: "o/r.js",
      number: 3,
    });
    expect(parsePrUrl("https://github.com/octo/repo/pull/0")).toBeUndefined();
    expect(parsePrUrl("https://github.com/octo/repo")).toBeUndefined();
  });
});

describe("parsePrArg", () => {
  it("takes nothing, a number or a PR URL", () => {
    expect(parsePrArg("")).toEqual({});
    expect(parsePrArg("  ")).toEqual({});
    expect(parsePrArg("123")).toEqual({ number: 123 });
    expect(parsePrArg("#123")).toEqual({ number: 123 });
    expect(parsePrArg("https://github.com/Octo/Repo/pull/9")).toEqual({
      number: 9,
      repo: "Octo/Repo",
    });
    expect(parsePrArg("https://github.com/octo/repo/pull/9/files#diff-1")).toEqual({
      number: 9,
      repo: "octo/repo",
    });
  });

  it.each([
    "0",
    "abc",
    "12 34",
    "https://github.com/octo/repo/issues/9",
    "https://gitlab.com/o/r/pull/9",
  ])("refuses %s", (arg) => {
    expect(() => parsePrArg(arg)).toThrow(/expected a GitHub PR URL or number/);
  });

  it("matches repos case-insensitively", () => {
    expect(sameRepo("Octo/Repo", "octo/repo")).toBe(true);
    expect(sameRepo("octo/repo", "octo/other")).toBe(false);
  });
});

const VIEW = {
  number: 7,
  title: "Add things",
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  author: { login: "alice" },
  body: "Body",
  baseRefName: "main",
  headRefName: "feature",
  baseRefOid: "a".repeat(40),
  headRefOid: "b".repeat(40),
  comments: [{ author: { login: "bob" }, body: "Nice", createdAt: "2026-01-02T00:00:00Z" }],
  reviews: [
    {
      author: { login: "carol" },
      body: "",
      state: "APPROVED",
      submittedAt: "2026-01-01T00:00:00Z",
    },
    {
      author: { login: "dave" },
      body: "",
      state: "COMMENTED",
      submittedAt: "2026-01-03T00:00:00Z",
    },
    { author: { login: "erin" }, body: "wip", state: "PENDING", submittedAt: null },
  ],
};

function failing(stderr: string, missing = false): GhRunner {
  return async () => {
    throw new GhError("gh failed", stderr, missing);
  };
}

async function errorOf(run: Promise<unknown>) {
  try {
    await run;
  } catch (e) {
    if (isApiError(e)) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected a rejection");
}

describe("viewPr", () => {
  it("asks for a number in the repo, or the current branch's PR", async () => {
    const calls: (readonly string[])[] = [];
    const gh: GhRunner = async (_cwd, args) => {
      calls.push(args);
      return JSON.stringify(VIEW);
    };
    const view = await viewPr(gh, "/cwd", "o/r", 7);
    await viewPr(gh, "/cwd", "o/r");
    expect(calls[0]?.slice(0, 5)).toEqual(["pr", "view", "7", "--repo", "o/r"]);
    expect(calls[1]?.slice(0, 3)).toEqual(["pr", "view", "--json"]);
    expect(view).toMatchObject({
      number: 7,
      state: "open",
      author: "alice",
      headRefOid: "b".repeat(40),
    });
    // Comments and reviews, oldest first, without pending and empty "commented" reviews.
    expect(view.comments).toEqual([
      { author: "carol", body: "", createdAt: "2026-01-01T00:00:00Z", review: "APPROVED" },
      { author: "bob", body: "Nice", createdAt: "2026-01-02T00:00:00Z" },
    ]);
  });

  it("turns gh failures into clear errors", async () => {
    expect(await errorOf(viewPr(failing("", true), "/", "o/r", 1))).toEqual({
      code: "gh_failed",
      message: "gh (the GitHub CLI) isn't installed or isn't on the PATH",
    });
    expect(
      await errorOf(
        viewPr(
          failing("To get started with GitHub CLI, please run:  gh auth login"),
          "/",
          "o/r",
          1,
        ),
      ),
    ).toMatchObject({ code: "gh_failed", message: expect.stringMatching(/gh auth login/) });
    expect(
      await errorOf(viewPr(failing('no pull requests found for branch "x"'), "/", "o/r")),
    ).toEqual({ code: "pr_not_found", message: "No PR for this branch" });
    expect(
      await errorOf(
        viewPr(
          failing("GraphQL: Could not resolve to a PullRequest with the number of 99."),
          "/",
          "o/r",
          99,
        ),
      ),
    ).toMatchObject({ code: "pr_not_found" });
    expect(await errorOf(viewPr(failing("HTTP 502"), "/", "o/r", 1))).toMatchObject({
      code: "gh_failed",
      message: expect.stringMatching(/HTTP 502/),
    });
  });

  it("refuses commit ids that aren't full hex shas", async () => {
    const gh: GhRunner = async () => JSON.stringify({ ...VIEW, headRefOid: "--upload-pack=x" });
    expect(await errorOf(viewPr(gh, "/", "o/r", 7))).toMatchObject({
      code: "gh_failed",
      message: expect.stringMatching(/malformed commit ids/),
    });
  });
});

describe("inlineComments", () => {
  it("reads one REST comment per line, oldest first, outdated ones at their original line", async () => {
    const gh: GhRunner = async (_cwd, args) => {
      expect(args).toEqual([
        "api",
        "--paginate",
        "repos/o/r/pulls/7/comments",
        "--jq",
        ".[] | tojson",
      ]);
      // As GitHub's REST API returns them, trimmed.
      return [
        JSON.stringify({
          id: 2,
          path: "a.ts",
          line: 4,
          original_line: 3,
          user: { login: "bob" },
          body: "reply",
          created_at: "2026-01-02T00:00:00Z",
          in_reply_to_id: 1,
          diff_hunk: "@@ -1 +1 @@",
        }),
        JSON.stringify({
          id: 1,
          path: "a.ts",
          line: null,
          original_line: 2,
          user: { login: "carol" },
          body: "why?",
          created_at: "2026-01-01T00:00:00Z",
        }),
        JSON.stringify({
          id: 3,
          path: "b.ts",
          line: null,
          original_line: null,
          user: null,
          body: "file comment",
          created_at: "2026-01-03T00:00:00Z",
        }),
        "",
      ].join("\n");
    };
    expect(await inlineComments(gh, "/", "o/r", 7)).toEqual([
      {
        id: 1,
        path: "a.ts",
        line: 2,
        author: "carol",
        body: "why?",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: 2,
        path: "a.ts",
        line: 4,
        author: "bob",
        body: "reply",
        createdAt: "2026-01-02T00:00:00Z",
        inReplyTo: 1,
      },
      {
        id: 3,
        path: "b.ts",
        line: null,
        author: "ghost",
        body: "file comment",
        createdAt: "2026-01-03T00:00:00Z",
      },
    ]);
  });

  it("fails clearly on malformed output", async () => {
    const gh: GhRunner = async () => "not json\n";
    expect(await errorOf(inlineComments(gh, "/", "o/r", 7))).toEqual({
      code: "gh_failed",
      message: "gh api repos/o/r/pulls/7/comments returned malformed JSON",
    });
  });
});
