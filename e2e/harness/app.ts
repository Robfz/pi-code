import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentInfo, Snapshot } from "@pi-code/protocol";
import { expect, type Page } from "@playwright/test";
import { type FixtureKind, writeFixture } from "./fixtures/generate.ts";
import { initRepo } from "./git.ts";
import { type Control, controlFile } from "./pi-wrapper.ts";
import type { Server } from "./server.ts";
import { sessionFileFor, writeSessionFile } from "./sessions.ts";
import { composer } from "./ui.ts";

/** A project dir with the fixture its conversation replays. One conversation per project. */
export interface Project {
  /** The dir's basename, unique per server: the pi wrapper's key for the fixture. */
  name: string;
  cwd: string;
  kind: FixtureKind;
  /** The fixture's user message: send it (`ui.ts` `sendPrompt`) to see the same text echoed. */
  prompt: string;
  /** The session file the agent reports (it exists only for `seedSession`, titled `prompt`). */
  sessionFile: string;
  sessionId: string;
}

export interface Conversation extends Project {
  /** Agent id: the conversation is at `/agents/<id>`. */
  id: string;
}

export interface ProjectOptions {
  kind: FixtureKind;
  /** fake-pi `--speed`: 0 (default) replays instantly, 1 with the generated spacing, N N× faster. */
  speed?: number;
  prompt?: string;
}

const lines = (count: number, line: (n: number) => string) =>
  `${Array.from({ length: count }, (_, i) => line(i + 1)).join("\n")}\n`;

/** Enough lines for the long-stream fixture's references (`@src/app.ts:12` and co.) to resolve. */
const FILES: Record<string, string> = {
  "README.md": "# Example\n\nAn e2e test project.\n",
  "src/app.ts": lines(12, (n) => `export const line${n} = ${n};`),
  "src/lib/util.ts": lines(60, (n) => `export const util${n} = ${n};`),
};

let projects = 0;

/**
 * Sets up projects and conversations on the worker's server, and follows their runs. Page-only
 * helpers are in `ui.ts`.
 */
export class App {
  readonly server: Server;
  readonly page: Page;

  constructor(server: Server, page: Page) {
    this.server = server;
    this.page = page;
  }

  /**
   * A project (a git repo with `FILES` in one commit, under the server's projects dir) whose
   * conversation, once started (API or UI), replays a `kind` fixture.
   */
  project(opts: ProjectOptions): Project {
    // The counter is per worker process, and each worker has its own server and projects dir.
    const name = `p-${++projects}`;
    const cwd = join(this.server.projectsDir, name);
    initRepo(cwd, FILES);
    const sessionId = randomUUID();
    const project: Project = {
      name,
      cwd,
      kind: opts.kind,
      prompt: opts.prompt ?? `Walk me through ${name}`,
      sessionFile: sessionFileFor(this.server.sessionsDir, cwd, sessionId, new Date()),
      sessionId,
    };
    const fixture = join(this.server.fixturesDir, `${name}.jsonl`);
    writeFixture(fixture, opts.kind, project);
    const control: Control = { fixture, speed: opts.speed ?? 0 };
    writeFileSync(controlFile(this.server.controlDir, cwd), JSON.stringify(control));
    return project;
  }

  /** A started conversation (`POST /api/agents`), not yet prompted. */
  async conversation(opts: ProjectOptions): Promise<Conversation> {
    const project = this.project(opts);
    const { agent } = await this.server.api<{ agent: AgentInfo }>("POST", "/api/agents", {
      cwd: project.cwd,
    });
    return { ...project, id: agent.id };
  }

  /**
   * A past session on disk, not open: listed by the catalog under its `prompt`, and showing a
   * `history` transcript when opened.
   */
  seedSession(): Project {
    const project = this.project({ kind: "history" });
    writeSessionFile(project.sessionFile, {
      id: project.sessionId,
      cwd: project.cwd,
      prompt: project.prompt,
      at: new Date(),
    });
    return project;
  }

  /** Opens the conversation and waits for its composer to accept input (the agent is ready). */
  async open(conversation: Conversation): Promise<void> {
    await this.page.goto(`/agents/${conversation.id}`);
    await expect(composer(this.page)).toBeEnabled();
  }

  /**
   * Waits for the agent to finish starting (`POST /api/agents` answers while it still is), so
   * its startup stays out of whatever is measured or observed next.
   */
  async waitReady(conversation: Conversation): Promise<void> {
    await expect.poll(async () => (await this.snapshot(conversation)).agent.status).toBe("ready");
  }

  snapshot(conversation: Conversation): Promise<Snapshot> {
    return this.server.api<Snapshot>("GET", `/api/agents/${conversation.id}/snapshot`);
  }

  /**
   * Whether the conversation's run is over on the server: not streaming, and its transcript ends
   * with a final assistant message after a user message. Fixtures have one prompt each, so that is
   * the end of the run the prompt started (before the prompt, there is no user message).
   */
  async runEnded(conversation: Conversation): Promise<boolean> {
    const { agent, live, transcript } = await this.snapshot(conversation);
    const messages = transcript.entries.flatMap((e) => (e.type === "message" ? [e.message] : []));
    const last = transcript.entries.at(-1);
    return (
      agent.status === "ready" &&
      !agent.isStreaming &&
      !live.run.active &&
      messages.some((m) => m.role === "user") &&
      last?.type === "message" &&
      last.message.role === "assistant" &&
      last.message.stopReason !== "toolUse"
    );
  }

  /** Waits for the run to end on the server, then in the page (which must show `conversation`). */
  async waitForRunEnd(conversation: Conversation): Promise<void> {
    await expect.poll(() => this.runEnded(conversation), { timeout: 60_000 }).toBe(true);
    await expect(this.page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
    await expect(this.page.getByTestId("live-turn")).toHaveCount(0);
  }
}
