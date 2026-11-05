/**
 * GitHub access for PR review (design/10-pr-review.md): parsing `/pr` arguments and `origin`
 * URLs, and the `gh` calls, run directly (no shell) through an injectable runner.
 */
import { execFile } from "node:child_process";
import type { PrState } from "@pi-code/protocol";
import { ApiError } from "../errors.ts";
import { FULL_SHA } from "../git/git.ts";

const GH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export class GhError extends Error {
  override name = "GhError";
  constructor(
    message: string,
    readonly stderr: string,
    /** `gh` isn't installed (or not on the PATH). */
    readonly missing = false,
  ) {
    super(message);
  }
}

/** Runs `gh args` in `cwd`; resolves with stdout, rejects with `GhError`. */
export type GhRunner = (cwd: string, args: readonly string[]) => Promise<string>;

/** The real `gh`, never prompting, with a 30 s timeout. */
export const runGh: GhRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      {
        cwd,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          GIT_TERMINAL_PROMPT: "0",
          NO_COLOR: "1",
        },
        timeout: GH_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        if (error === null) return resolve(stdout);
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(new GhError(`gh ${args[0]} failed: ${error.message}`, stderr, missing));
      },
    );
    // Nothing to read: an open stdin could keep a command waiting for input.
    child.stdin?.end();
  });

const NAME = "[\\w.-]+";

/**
 * `owner/name` of a GitHub remote URL (`git@github.com:o/r.git`, `ssh://git@github.com/o/r`,
 * `https://github.com/o/r.git`, …), else `undefined`.
 */
export function parseGithubRemote(url: string): string | undefined {
  const match = new RegExp(
    `^(?:(?:https?|git|ssh)://(?:[^@/]+@)?github\\.com(?::\\d+)?/|(?:[^@/:]+@)?github\\.com:)(${NAME})/(${NAME}?)(?:\\.git)?/?$`,
    "i",
  ).exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export interface PrTarget {
  /** Absent: the PR of the current branch. */
  number?: number;
  /** `owner/name`, when given as a URL. */
  repo?: string;
}

const PR_URL = new RegExp(
  `^https?://(?:www\\.)?github\\.com/(${NAME})/(${NAME})/pull/(\\d+)(?:[/?#].*)?$`,
  "i",
);

const validNumber = (n: number) => Number.isSafeInteger(n) && n > 0;

/** The repo (`owner/name`) and number of a GitHub PR URL, else `undefined`. */
export function parsePrUrl(url: string): Required<PrTarget> | undefined {
  const match = PR_URL.exec(url.trim());
  const number = Number(match?.[3]);
  return match && validNumber(number) ? { number, repo: `${match[1]}/${match[2]}` } : undefined;
}

/** A `/pr` argument: empty, a number (`12` or `#12`) or a PR URL. Throws `invalid_body`. */
export function parsePrArg(arg: string): PrTarget {
  const text = arg.trim();
  if (text === "") return {};
  const number = Number(/^#?(\d+)$/.exec(text)?.[1]);
  if (validNumber(number)) return { number };
  const url = parsePrUrl(text);
  if (url !== undefined) return url;
  throw new ApiError("invalid_body", `expected a GitHub PR URL or number, got "${text}"`);
}

/** Whether two `owner/name`s name the same repository (GitHub ignores case). */
export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A top-level comment or a submitted review. */
export interface PrComment {
  author: string;
  body: string;
  createdAt: string;
  /** A review's state (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`). */
  review?: string;
}

/** An inline review comment. */
export interface InlineComment {
  id: number;
  path: string;
  /** The line in the diff's file; `null` when outdated without an original line. */
  line: number | null;
  author: string;
  body: string;
  createdAt: string;
  inReplyTo?: number;
}

export interface PrView {
  number: number;
  title: string;
  url: string;
  state: PrState;
  author: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  /** Top-level comments and reviews, oldest first. */
  comments: PrComment[];
}

const VIEW_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "author",
  "body",
  "baseRefName",
  "headRefName",
  "baseRefOid",
  "headRefOid",
  "comments",
  "reviews",
].join(",");

/** A failed `gh` as the API error the user should see. */
function ghFailure(e: unknown, what: string): ApiError {
  if (!(e instanceof GhError)) return new ApiError("gh_failed", `${what} failed: ${String(e)}`);
  if (e.missing) {
    return new ApiError("gh_failed", "gh (the GitHub CLI) isn't installed or isn't on the PATH");
  }
  const stderr = e.stderr.trim();
  if (/gh auth login|not logged in|authentication required/i.test(stderr)) {
    return new ApiError("gh_failed", "gh isn't logged in to GitHub: run `gh auth login`");
  }
  if (/no pull requests found/i.test(stderr)) {
    return new ApiError("pr_not_found", "No PR for this branch");
  }
  if (/could not resolve to a pullrequest/i.test(stderr)) {
    return new ApiError("pr_not_found", `${what}: no such pull request`);
  }
  return new ApiError("gh_failed", `${what} failed: ${stderr || e.message}`);
}

function login(value: unknown): string {
  const name = (value as { login?: unknown } | null)?.login;
  return typeof name === "string" ? name : "ghost";
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * `gh pr view` of PR `number` in `repo`, or without a number the PR of the current branch (gh
 * resolves it from the checkout in `cwd`). Throws `pr_not_found` or `gh_failed`.
 */
export async function viewPr(
  gh: GhRunner,
  cwd: string,
  repo: string,
  number?: number,
): Promise<PrView> {
  const args =
    number === undefined
      ? ["pr", "view", "--json", VIEW_FIELDS]
      : ["pr", "view", String(number), "--repo", repo, "--json", VIEW_FIELDS];
  const what = number === undefined ? "gh pr view" : `gh pr view ${number} --repo ${repo}`;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(await gh(cwd, args)) as Record<string, unknown>;
  } catch (e) {
    throw e instanceof SyntaxError
      ? new ApiError("gh_failed", `${what} returned malformed JSON`)
      : ghFailure(e, what);
  }
  const baseRefOid = str(data.baseRefOid);
  const headRefOid = str(data.headRefOid);
  // They go to git as arguments.
  if (!FULL_SHA.test(baseRefOid) || !FULL_SHA.test(headRefOid)) {
    throw new ApiError("gh_failed", `${what} returned malformed commit ids`);
  }
  const state = str(data.state).toLowerCase();
  const comments: PrComment[] = [];
  for (const c of Array.isArray(data.comments) ? data.comments : []) {
    comments.push({ author: login(c?.author), body: str(c?.body), createdAt: str(c?.createdAt) });
  }
  for (const r of Array.isArray(data.reviews) ? data.reviews : []) {
    const review = str(r?.state);
    const body = str(r?.body);
    // Pending reviews aren't submitted; an empty "commented" review only wraps inline comments.
    if (review === "PENDING" || (review === "COMMENTED" && body.trim() === "")) continue;
    comments.push({ author: login(r?.author), body, createdAt: str(r?.submittedAt), review });
  }
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    number: Number(data.number),
    title: str(data.title),
    url: str(data.url),
    state: state === "merged" || state === "closed" ? state : "open",
    author: login(data.author),
    body: str(data.body),
    baseRefName: str(data.baseRefName),
    headRefName: str(data.headRefName),
    baseRefOid,
    headRefOid,
    comments,
  };
}

/** The inline review comments of PR `number`, oldest first. Throws `gh_failed`. */
export async function inlineComments(
  gh: GhRunner,
  cwd: string,
  repo: string,
  number: number,
): Promise<InlineComment[]> {
  const path = `repos/${repo}/pulls/${number}/comments`;
  let out: string;
  try {
    // One REST comment object per line, whatever the page count.
    out = await gh(cwd, ["api", "--paginate", path, "--jq", ".[] | tojson"]);
  } catch (e) {
    throw ghFailure(e, `gh api ${path}`);
  }
  const comments: InlineComment[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    let c: Record<string, unknown>;
    try {
      c = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new ApiError("gh_failed", `gh api ${path} returned malformed JSON`);
    }
    // `line` is null once the comment is outdated; `original_line` is where it was made.
    const at = typeof c.line === "number" ? c.line : c.original_line;
    const comment: InlineComment = {
      id: Number(c.id),
      path: str(c.path),
      line: typeof at === "number" ? at : null,
      author: login(c.user),
      body: str(c.body),
      createdAt: str(c.created_at),
    };
    if (typeof c.in_reply_to_id === "number") comment.inReplyTo = c.in_reply_to_id;
    comments.push(comment);
  }
  return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
