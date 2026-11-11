/**
 * The PR guide job (design/11-pr-guide.md, "Job"): a one-off `pi --mode json` run in a temporary
 * detached worktree at the PR head, with read-only tools and the `submit_guide` tool, whose
 * arguments become the guide.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PrGuide, PrGuideSection } from "@pi-code/protocol";
import { LineSplitter } from "../agents/jsonl.ts";
import { gitDiff, gitFailed, runGit } from "../git/git.ts";
import { gitCommonDir } from "../git/pr.ts";
import { GUIDE_VERSION, isGuideSection } from "./guide-format.ts";
import { type GuideFile, hunkIds, labelledDiff, splitHunks, unitIds } from "./guide-hunks.ts";
import { GUIDE_TOOL, type GuidePr, guidePrompt } from "./guide-prompt.ts";

/** The folder of the jobs' worktrees and diff files, in the repository's common git dir. */
export const GUIDE_DIR = "pi-code-guide";
const TOOLS = `read,grep,find,ls,${GUIDE_TOOL}`;

const ADD_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 120_000;
/** How long an aborted pi gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5_000;
const STDERR_TAIL_LINES = 20;
/** The most unknown ids a failure names. */
const LISTED_IDS = 5;

/**
 * The worktrees of this server's running jobs, which another job's cleanup of leftovers must
 * leave alone. Anything else in a `pi-code-guide` folder is left by a killed job or a stopped
 * server.
 */
const activeWorktrees = new Set<string>();

/** A guide job's failure, with a message for the user. */
export class GuideJobError extends Error {
  override name = "GuideJobError";
}

/** What a guide is generated from. */
export interface GuideInput {
  /**
   * The conversation's folder. The guide covers the PR diff under it, with paths relative to it,
   * as the Changes tab's PR mode shows it there.
   */
  cwd: string;
  /**
   * `cwd` relative to the repository's top level (`repoFolder`): `""` there, else ending in
   * `/`. Part of the guide key, since the diff under `cwd` depends on it.
   */
  folder: string;
  pr: GuidePr;
  baseSha: string;
  headSha: string;
}

export interface GuideJobOptions {
  piBin: string;
  /** The guide extension (`submit_guide`). */
  extensionPath: string;
  /** pi's `--model`. */
  model: string;
}

/** `GuideInput` plus the PR diff's files, split into hunks. */
export interface GuideJobInput extends GuideInput {
  files: GuideFile[];
}

/** The sections of `submit_guide`'s arguments, each one's hunk ids deduplicated. */
function parseSections(args: unknown): PrGuideSection[] {
  const sections = (args as { sections?: unknown } | null)?.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new GuideJobError(`${GUIDE_TOOL} was called without sections`);
  }
  return sections.map((s: unknown, i) => {
    if (!isGuideSection(s))
      throw new GuideJobError(`${GUIDE_TOOL}'s section ${i + 1} is malformed`);
    if (s.hunks.length === 0) {
      throw new GuideJobError(`${GUIDE_TOOL}'s section "${s.title}" has no hunks`);
    }
    return { title: s.title, explanation: s.explanation, hunks: [...new Set(s.hunks)] };
  });
}

/**
 * The guide from `submit_guide`'s arguments: each section's hunks must be hunks of the diff;
 * `other` gets every unit no section claims, in diff order.
 */
export function buildGuide(args: unknown, input: GuideJobInput): PrGuide {
  const sections = parseSections(args);
  const known = new Set(hunkIds(input.files));
  const unknown = [...new Set(sections.flatMap((s) => s.hunks).filter((id) => !known.has(id)))];
  if (unknown.length > 0) {
    const listed = unknown.slice(0, LISTED_IDS).join(", ");
    const more = unknown.length > LISTED_IDS ? ` and ${unknown.length - LISTED_IDS} more` : "";
    throw new GuideJobError(`${GUIDE_TOOL} referenced unknown hunk ids: ${listed}${more}`);
  }
  const claimed = new Set(sections.flatMap((s) => s.hunks));
  return {
    ...identity(input),
    sections,
    other: unitIds(input.files).filter((id) => !claimed.has(id)),
  };
}

function identity(input: GuideInput): Omit<PrGuide, "sections" | "other"> {
  return {
    version: GUIDE_VERSION,
    repo: input.pr.repo,
    number: input.pr.number,
    baseSha: input.baseSha,
    headSha: input.headSha,
  };
}

/**
 * Removes what the jobs that aren't running left in `dir`: worktrees and diff files, and git's
 * records of worktrees in `dir` whose folders are gone. A repository-wide `git worktree prune`
 * would also drop the user's own worktrees whose folders are missing (moved by hand, on an
 * unmounted disk), so only `dir`'s records are removed.
 */
async function removeLeftovers(cwd: string, dir: string): Promise<void> {
  const { stdout } = await runGit(cwd, ["worktree", "list", "--porcelain", "-z"]);
  const recorded = stdout
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length))
    .filter((path) => dirname(path) === dir);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const leftovers = new Set([...recorded, ...names.map((name) => join(dir, name))]);
  for (const path of leftovers) {
    if (activeWorktrees.has(path.replace(/\.diff$/, ""))) continue;
    await removeWorktree(cwd, path);
  }
}

/**
 * `git worktree remove --force` (which also drops git's record of it, even when its folder is
 * gone), then deletes whatever is left at `path`: a diff file, or a folder git doesn't know as a
 * worktree.
 */
async function removeWorktree(cwd: string, path: string): Promise<void> {
  if (!path.endsWith(".diff")) {
    await runGit(cwd, ["worktree", "remove", "--force", path], {
      timeoutMs: REMOVE_TIMEOUT_MS,
    }).catch(() => {});
  }
  await rm(path, { recursive: true, force: true });
}

/** The tail of pi's stderr kept for failures. */
function tail(lines: string[]): string {
  return lines.slice(-STDERR_TAIL_LINES).join("\n").trim();
}

interface PiEvent {
  type?: unknown;
  toolName?: unknown;
  isError?: unknown;
  result?: { details?: unknown };
  message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
  success?: unknown;
  finalError?: unknown;
}

/**
 * Runs pi in `cwd` and resolves with the arguments of its first successful `submit_guide` call,
 * as the tool returns them in its result's `details`: those pi validated against the tool's
 * schema, after coercing them (`tool_execution_start`'s raw arguments may not match it).
 */
function runPi(
  opts: GuideJobOptions,
  cwd: string,
  prompt: string,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const args = [
      "--mode",
      "json",
      "--no-session",
      "--model",
      opts.model,
      "-t",
      TOOLS,
      "-e",
      opts.extensionPath,
      prompt,
    ];
    const child = spawn(opts.piBin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let submitted: { args: unknown } | undefined;
    let modelError: string | undefined;
    const stderr: string[] = [];

    const onEvent = (line: string) => {
      let event: PiEvent;
      try {
        event = JSON.parse(line) as PiEvent;
      } catch {
        return;
      }
      if (
        event.type === "tool_execution_end" &&
        event.toolName === GUIDE_TOOL &&
        event.isError !== true
      ) {
        submitted ??= { args: event.result?.details };
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
        // A later reply (pi's auto-retry recovering) clears an earlier error.
        const { stopReason, errorMessage } = event.message;
        modelError =
          stopReason === "error" && typeof errorMessage === "string" ? errorMessage : undefined;
      } else if (event.type === "auto_retry_end" && event.success === false) {
        if (typeof event.finalError === "string") modelError = event.finalError;
      }
    };
    const out = new LineSplitter(onEvent);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stdout.on("end", () => out.end());
    const err = new LineSplitter((line) => {
      stderr.push(line);
      if (stderr.length > STDERR_TAIL_LINES) stderr.shift();
    });
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.stderr.on("end", () => err.end());

    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    signal.addEventListener("abort", abort, { once: true });

    child.on("error", (e) => {
      signal.removeEventListener("abort", abort);
      reject(new GuideJobError(`couldn't start pi (${opts.piBin}): ${e.message}`));
    });
    child.on("close", (code, killedBy) => {
      signal.removeEventListener("abort", abort);
      clearTimeout(killTimer);
      if (signal.aborted) return reject(signal.reason);
      if (submitted !== undefined) return resolve(submitted.args);
      const detail = modelError ?? tail(stderr);
      if (code !== 0) {
        const how = killedBy === null ? `exited with code ${code}` : `was killed (${killedBy})`;
        return reject(new GuideJobError(`pi ${how}${detail ? `: ${detail}` : ""}`));
      }
      reject(
        new GuideJobError(
          `the guide job ended without calling ${GUIDE_TOOL}${modelError ? `: ${modelError}` : ""}`,
        ),
      );
    });
  });
}

/**
 * Runs the guide job for `input` and returns its guide. The job's worktree, at the head under
 * `<common git dir>/pi-code-guide/<id>`, and its labelled diff (`<id>.diff` beside it) are
 * removed when it ends, however it ends; leftovers of jobs that aren't running are removed
 * first. pi runs in the worktree's copy of `input.cwd` (`input.folder`), which the diff's paths
 * are relative to.
 * Aborting `signal` kills pi and rejects with the signal's reason.
 */
export async function runGuideJob(
  input: GuideJobInput,
  opts: GuideJobOptions,
  signal: AbortSignal,
): Promise<PrGuide> {
  const dir = join(await gitCommonDir(input.cwd), GUIDE_DIR);
  const worktree = join(dir, randomUUID());
  const diffPath = `${worktree}.diff`;
  activeWorktrees.add(worktree);
  try {
    await removeLeftovers(input.cwd, dir);
    await mkdir(dir, { recursive: true });
    await writeFile(diffPath, labelledDiff(input.files));
    signal.throwIfAborted();
    const add = ["worktree", "add", "--detach", worktree, input.headSha];
    // The job only reads files: LFS pointers do for it, and no hook (the user's, or one the
    // head's tree holds, like husky's) runs on its checkout.
    await runGit(input.cwd, ["-c", "core.hooksPath=/dev/null", ...add], {
      timeoutMs: ADD_TIMEOUT_MS,
      env: { GIT_LFS_SKIP_SMUDGE: "1" },
    }).catch((e: unknown) => {
      throw gitFailed(add, e);
    });
    const cwd = join(worktree, input.folder);
    // The folder has no tracked file at the head when the PR deletes its last one.
    await mkdir(cwd, { recursive: true });
    // From here to pi's abort listener nothing awaits, so no abort goes unseen.
    signal.throwIfAborted();
    const prompt = guidePrompt(input.pr, input.headSha, diffPath);
    const args = await runPi(opts, cwd, prompt, signal);
    return buildGuide(args, input);
  } finally {
    await removeWorktree(input.cwd, worktree);
    await rm(diffPath, { force: true });
    activeWorktrees.delete(worktree);
  }
}

/**
 * Generates the guide of `input`'s PR diff: the pinned PR diff under `input.cwd`, the one the
 * Changes tab's PR mode shows there, split into hunks, then the job. A diff without hunks needs
 * no job: its guide has no sections.
 */
export async function generateGuide(
  input: GuideInput,
  opts: GuideJobOptions,
  signal: AbortSignal,
): Promise<PrGuide> {
  const diff = await gitDiff(input.cwd, { range: { from: input.baseSha, to: input.headSha } });
  const files = splitHunks(diff.files);
  signal.throwIfAborted();
  if (hunkIds(files).length === 0) {
    return { ...identity(input), sections: [], other: unitIds(files) };
  }
  return runGuideJob({ ...input, files }, opts, signal);
}
