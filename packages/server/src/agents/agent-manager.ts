import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  AgentId,
  AgentInfo,
  AgentStatus,
  Attention,
  JsonAgentSessionEvent,
  RpcExtensionUIRequest,
  RpcSessionState,
} from "@pi-code/protocol";
import { readSessionHeader } from "../catalog/sessions.ts";
import { ApiError } from "../errors.ts";
import { isInside } from "../paths.ts";
import { AgentHost, type AgentHostOptions, type HostExit } from "./agent-host.ts";
import { AgentPipeline, type AttentionTrigger, type PipelineOptions } from "./pipeline.ts";
import { needsTrustDecision } from "./trust.ts";

/** Environment variable carrying the user's trust decision to the pi-code extension. */
export const TRUST_ENV = "PI_CODE_TRUST";

/** What to spawn for an agent. */
export interface SpawnSpec {
  bin: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface SpawnRequest {
  cwd: string;
  sessionFile?: string;
  /** The user's project-trust answer, passed to pi as `PI_CODE_TRUST` (set by the manager). */
  trust?: "yes" | "no";
}

/**
 * Per-agent records, in stdout order, as observed before they enter the agent's pipeline.
 * `status` records follow every reported info change (see `PipelineOptions.onAgentInfo`).
 */
export type AgentRecord =
  | { kind: "event"; event: JsonAgentSessionEvent }
  | { kind: "ui_request"; request: RpcExtensionUIRequest }
  | { kind: "status"; agent: AgentInfo };

export type AgentRecordHandler = (agent: Agent, record: AgentRecord) => void;

export interface AgentManagerDeps {
  /** `$HOME`: agents' cwds must resolve inside it. */
  home: string;
  /** Builds the command line for an agent (the real one runs `pi --mode rpc …`). */
  command: (req: SpawnRequest) => SpawnSpec;
  /**
   * pi's agent dir. When set, agents get the project-trust pre-check (`trust.json` is read from
   * here) and session files below it may be opened even if it is outside `$HOME`.
   */
  agentDir?: string;
  /** Pipeline tuning (git status, debounce). */
  pipeline?: Pick<PipelineOptions, "gitStatus" | "gitDebounceMs" | "curator">;
  /** Observes every agent record; replaceable later with `setRecordHandler`. */
  onRecord?: AgentRecordHandler;
  /** Notification triggers (finished / failed / input), for push. */
  onTrigger?: (trigger: AttentionTrigger) => void;
  hostOptions?: AgentHostOptions;
  /** Events kept per agent for SSE replay. Default 10,000. */
  eventLogCapacity?: number;
  newId?: () => AgentId;
}

/** The default `command` for real pi. */
export function piCommand(piBin: string, extensionPath: string): (req: SpawnRequest) => SpawnSpec {
  return (req) => ({
    bin: piBin,
    args: [
      "--mode",
      "rpc",
      "--extension",
      extensionPath,
      ...(req.sessionFile ? ["--session", req.sessionFile] : []),
    ],
  });
}

/** One conversation: its pi process, its event pipeline, and the server's view of it. */
export class Agent {
  readonly id: AgentId;
  readonly cwd: string;
  readonly startedAt: string;
  status: AgentStatus = "starting";
  attention: Attention = "none";
  /** Cached `get_state` data (kept current by the pipeline). */
  state: RpcSessionState | null = null;
  /** Session file asked for at open, until pi reports its own through `state`. */
  requestedSessionFile: string | undefined;
  /** Whether this pi process has the pi-code extension's `pi-code-tree` command (checked once). */
  hasTreeCommand = false;
  readonly pipeline: AgentPipeline;
  private currentHost: AgentHost | null;

  constructor(
    id: AgentId,
    cwd: string,
    host: AgentHost | null,
    pipelineOptions: PipelineOptions = {},
  ) {
    this.id = id;
    this.cwd = cwd;
    this.currentHost = host;
    this.startedAt = new Date().toISOString();
    this.pipeline = new AgentPipeline(this, pipelineOptions);
  }

  /** The current pi process. Throws while awaiting the trust decision (no process yet). */
  get host(): AgentHost {
    if (this.currentHost === null) {
      throw new ApiError("agent_busy", "the agent is waiting for the project-trust decision");
    }
    return this.currentHost;
  }

  get hasHost(): boolean {
    return this.currentHost !== null;
  }

  /** Replaces the pi process (spawn after the trust decision, restart). */
  setHost(host: AgentHost): void {
    this.currentHost = host;
    this.hasTreeCommand = false;
  }

  /** The session file this agent has open (pi's view once known, else the requested one). */
  get sessionFile(): string | undefined {
    return this.state?.sessionFile ?? this.requestedSessionFile;
  }

  info(): AgentInfo {
    const info: AgentInfo = {
      id: this.id,
      cwd: this.cwd,
      status: this.status,
      isStreaming: this.status === "ready" && (this.state?.isStreaming ?? false),
      attention: this.attention,
      startedAt: this.startedAt,
    };
    if (this.status === "awaiting_trust") info.trustPrompt = { cwd: this.cwd };
    const sessionFile = this.sessionFile;
    if (sessionFile) info.sessionFile = sessionFile;
    if (this.state?.sessionId) info.sessionId = this.state.sessionId;
    if (this.state?.sessionName) info.sessionName = this.state.sessionName;
    if (this.status === "exited" && this.currentHost) {
      const exit = this.currentHost.exitInfo;
      if (typeof exit?.code === "number") info.exitCode = exit.code;
      info.stderrTail = this.currentHost.stderrTail;
    }
    return info;
  }
}

export interface AgentManagerEvents {
  /**
   * An agent's info changed: status or attention, or `isStreaming`, `sessionName`,
   * `sessionFile` or `sessionId`.
   */
  agent: [AgentInfo];
  /** An agent was closed and removed. */
  closed: [AgentId];
}

/** Registry of open agents. */
export class AgentManager extends EventEmitter<AgentManagerEvents> {
  private readonly deps: AgentManagerDeps;
  private readonly agents = new Map<AgentId, Agent>();
  private onRecord: AgentRecordHandler | undefined;
  private homeReal: Promise<string> | undefined;
  /** In-flight `openSession` calls by session file, so concurrent opens share one agent. */
  private readonly opening = new Map<string, Promise<{ agent: Agent; existing: boolean }>>();

  constructor(deps: AgentManagerDeps) {
    super();
    this.deps = deps;
    this.onRecord = deps.onRecord;
  }

  /** `$HOME` as configured. */
  get home(): string {
    return this.deps.home;
  }

  /** Plugs the event pipeline in (or replaces it). */
  setRecordHandler(handler: AgentRecordHandler | undefined): void {
    this.onRecord = handler;
  }

  get(id: AgentId): Agent | undefined {
    return this.agents.get(id);
  }

  /** Like `get`, but throws `agent_not_found`. */
  require(id: AgentId): Agent {
    const agent = this.agents.get(id);
    if (!agent) throw new ApiError("agent_not_found", `no agent ${id}`);
    return agent;
  }

  list(): AgentInfo[] {
    return [...this.agents.values()].map((a) => a.info());
  }

  /**
   * The agent (other than `except`) that has `sessionFile` open, if any. Exited agents keep
   * their session: they stay listed until closed and restart into it.
   */
  ownerOf(sessionFile: string, except?: AgentId): AgentId | undefined {
    for (const agent of this.agents.values()) {
      if (agent.id !== except && agent.sessionFile === sessionFile) return agent.id;
    }
    return undefined;
  }

  /**
   * Opens a new agent with a new session in `cwd` (must resolve inside `$HOME`). Returns right
   * away with `status: "starting"` (or `"awaiting_trust"`); the pipeline makes it `ready` once
   * state and transcript are loaded.
   */
  async open(req: { cwd: string }): Promise<Agent> {
    const cwd = await this.resolveCwd(req.cwd);
    return this.create(cwd, undefined);
  }

  /**
   * Resumes a session file. If an agent already has it open, returns that agent
   * (`existing: true`; an exited one is restarted); otherwise spawns pi with `--session` in
   * the cwd from the session header. `session_not_found` when the file isn't a pi session.
   */
  async openSession(sessionFile: string): Promise<{ agent: Agent; existing: boolean }> {
    const file = await this.resolveSessionFile(sessionFile);
    const pending = this.opening.get(file);
    if (pending) return pending.then(({ agent }) => ({ agent, existing: true }));
    const run = (async () => {
      const ownerId = this.ownerOf(file);
      if (ownerId !== undefined) {
        const owner = this.require(ownerId);
        if (owner.status === "exited") await this.restart(owner.id);
        return { agent: owner, existing: true };
      }
      const header = await readSessionHeader(file);
      if (header === undefined) {
        throw new ApiError("session_not_found", `not a pi session file: ${sessionFile}`);
      }
      const cwd = await this.resolveCwd(header.cwd);
      return { agent: await this.create(cwd, file), existing: false };
    })();
    this.opening.set(file, run);
    try {
      return await run;
    } finally {
      this.opening.delete(file);
    }
  }

  /**
   * Answers the project-trust prompt of an `awaiting_trust` agent: spawns pi with
   * `PI_CODE_TRUST=yes|no` (the pi-code extension relays it and pi saves it to `trust.json`).
   */
  trust(id: AgentId, trusted: boolean): Agent {
    const agent = this.require(id);
    if (agent.status !== "awaiting_trust") {
      throw new ApiError("agent_busy", "the agent is not waiting for a trust decision");
    }
    agent.attention = "none";
    this.spawnHost(agent, trusted ? "yes" : "no");
    agent.pipeline.spawned();
    return agent;
  }

  /**
   * Respawns an exited agent with its last session file (same agent id and event stream).
   * `agent_busy` unless exited; `session_owned` if another agent opened that session meanwhile.
   */
  async restart(id: AgentId): Promise<Agent> {
    const agent = this.require(id);
    if (agent.status !== "exited") {
      throw new ApiError("agent_busy", `only exited agents can be restarted (${agent.status})`);
    }
    const file = agent.sessionFile;
    if (file !== undefined) {
      const other = this.ownerOf(file, agent.id);
      if (other !== undefined) {
        throw new ApiError("session_owned", `session is open in agent ${other}`);
      }
    }
    const awaitTrust = await this.needsTrust(agent.cwd);
    if (agent.status !== "exited" || this.agents.get(id) !== agent) return agent;
    if (file !== undefined) agent.requestedSessionFile = file;
    if (awaitTrust) {
      agent.pipeline.setStatus("awaiting_trust");
      this.requestTrust(agent);
    } else {
      this.spawnHost(agent);
      agent.pipeline.spawned();
    }
    return agent;
  }

  /** Stops the agent's process and removes it. */
  async close(id: AgentId): Promise<void> {
    const agent = this.require(id);
    if (agent.hasHost) await agent.host.close();
    else {
      agent.status = "exited";
      agent.pipeline.publishStatus();
    }
    await agent.pipeline.enqueue(() => {}); // the final `agent_status` reaches subscribers
    agent.pipeline.dispose();
    if (this.agents.get(id) === agent) {
      this.agents.delete(id);
      this.emit("closed", id);
    }
  }

  /** Closes every agent in parallel (shutdown). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.agents.keys()].map((id) => this.close(id).catch(() => {})));
  }

  private async create(cwd: string, sessionFile: string | undefined): Promise<Agent> {
    const awaitTrust = await this.needsTrust(cwd);
    const id = this.deps.newId?.() ?? randomBytes(9).toString("base64url");
    const agent: Agent = new Agent(id, cwd, null, {
      ...this.deps.pipeline,
      ...(this.deps.eventLogCapacity ? { eventLogCapacity: this.deps.eventLogCapacity } : {}),
      onAgentInfo: (info) => {
        this.emit("agent", info);
        this.record(agent, { kind: "status", agent: info });
      },
      onTrigger: (trigger) => this.deps.onTrigger?.(trigger),
    });
    agent.requestedSessionFile = sessionFile;
    this.agents.set(id, agent);
    if (awaitTrust) {
      agent.status = "awaiting_trust";
      agent.attention = "input";
      agent.pipeline.start();
      this.deps.onTrigger?.({ kind: "input", agentId: id, trustPrompt: { cwd } });
    } else {
      this.spawnHost(agent);
      agent.pipeline.start();
    }
    return agent;
  }

  private requestTrust(agent: Agent): void {
    agent.pipeline.setAttention("input");
    this.deps.onTrigger?.({ kind: "input", agentId: agent.id, trustPrompt: { cwd: agent.cwd } });
  }

  private async needsTrust(cwd: string): Promise<boolean> {
    if (this.deps.agentDir === undefined) return false;
    try {
      return await needsTrustDecision({ cwd, home: this.deps.home, agentDir: this.deps.agentDir });
    } catch (e) {
      console.warn(`[agents] trust pre-check failed for ${cwd}: ${(e as Error).message}`);
      return false;
    }
  }

  /** Spawns pi for `agent` (`--session` with its session file, if any) and wires its records. */
  private spawnHost(agent: Agent, trust?: "yes" | "no"): void {
    const sessionFile = agent.sessionFile;
    const spec = this.deps.command({
      cwd: agent.cwd,
      ...(sessionFile ? { sessionFile } : {}),
      ...(trust ? { trust } : {}),
    });
    const env: NodeJS.ProcessEnv = { ...(spec.env ?? process.env) };
    delete env[TRUST_ENV];
    if (trust) env[TRUST_ENV] = trust;
    const host = AgentHost.spawn(spec.bin, spec.args, {
      cwd: agent.cwd,
      env,
      ...this.deps.hostOptions,
    });
    agent.setHost(host);
    const id = agent.id;
    host.on("event", (event) => {
      this.record(agent, { kind: "event", event });
      agent.pipeline.onEvent(event);
    });
    host.on("ui_request", (request) => {
      this.record(agent, { kind: "ui_request", request });
      agent.pipeline.onUiRequest(request);
    });
    host.on("protocol_error", (err) => {
      console.warn(`[agent ${id}] ${err.message}`);
    });
    host.on("exit", (exit) => {
      if (agent.hasHost && agent.host === host) this.onExit(agent, exit);
    });
  }

  private onExit(agent: Agent, exit: HostExit): void {
    // Set right away so commands get `agent_exited`; published in order by the pipeline.
    agent.status = "exited";
    if (!exit.requested) {
      const why = exit.error?.message ?? `code ${exit.code}, signal ${exit.signal}`;
      console.warn(`[agent ${agent.id}] pi exited unexpectedly (${why})`);
    }
    agent.pipeline.onExit();
  }

  private record(agent: Agent, record: AgentRecord): void {
    if (!this.onRecord) return;
    try {
      this.onRecord(agent, record);
    } catch (e) {
      console.error(`[agent ${agent.id}] record handler failed:`, e);
    }
  }

  private async realHome(): Promise<string> {
    this.homeReal ??= realpath(this.deps.home);
    return this.homeReal;
  }

  /**
   * A session file's realpath. Must be an existing `.jsonl` file (else `session_not_found`)
   * inside `$HOME` or pi's sessions dir (else `outside_home`).
   */
  async resolveSessionFile(file: string): Promise<string> {
    if (typeof file !== "string" || !isAbsolute(file)) {
      throw new ApiError("invalid_body", "sessionFile must be an absolute path");
    }
    let real: string;
    try {
      real = await realpath(file);
      if (!real.endsWith(".jsonl") || !(await stat(real)).isFile()) throw new Error("not a file");
    } catch {
      throw new ApiError("session_not_found", `no session file ${file}`);
    }
    const roots = [await this.realHome()];
    if (this.deps.agentDir !== undefined) {
      roots.push(await realpath(join(this.deps.agentDir, "sessions")).catch(() => ""));
    }
    if (!roots.some((root) => root !== "" && isInside(root, real))) {
      throw new ApiError("outside_home", `session file must be inside ${roots[0]}`);
    }
    return real;
  }

  private async resolveCwd(cwd: string): Promise<string> {
    if (typeof cwd !== "string" || !isAbsolute(cwd)) {
      throw new ApiError("invalid_body", "cwd must be an absolute path");
    }
    const home = await this.realHome();
    const outside = () => new ApiError("outside_home", `cwd must be inside ${home}`);
    let real: string;
    try {
      real = await realpath(cwd);
    } catch {
      if (!isInside(home, cwd) && !isInside(this.deps.home, cwd)) throw outside();
      throw new ApiError("invalid_body", `cwd does not exist: ${cwd}`);
    }
    if (!isInside(home, real)) throw outside();
    if (!(await stat(real)).isDirectory()) {
      throw new ApiError("invalid_body", `cwd is not a directory: ${cwd}`);
    }
    return real;
  }
}
