import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { ApiError } from "../errors.ts";
import type {
  AgentId,
  AgentInfo,
  AgentStatus,
  Attention,
  PiEvent,
  PiSessionState,
  PiUiRequest,
} from "../types-temp.ts";
import { AgentHost, type AgentHostOptions, type HostExit } from "./agent-host.ts";

/** Whether `path` is `dir` or below it (both absolute, already resolved). */
function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** What to spawn for an agent. */
export interface SpawnSpec {
  bin: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface SpawnRequest {
  cwd: string;
  sessionFile?: string;
}

/**
 * Per-agent records, in stdout order, for the event pipeline (S4). `status` records are emitted
 * whenever the agent's `AgentInfo` changes status.
 */
export type AgentRecord =
  | { kind: "event"; event: PiEvent }
  | { kind: "ui_request"; request: PiUiRequest }
  | { kind: "status"; agent: AgentInfo };

export type AgentRecordHandler = (agent: Agent, record: AgentRecord) => void;

export interface AgentManagerDeps {
  /** `$HOME`: agents' cwds must resolve inside it. */
  home: string;
  /** Builds the command line for an agent (the real one runs `pi --mode rpc …`). */
  command: (req: SpawnRequest) => SpawnSpec;
  /** Receives every agent record; replaceable later with `setRecordHandler`. */
  onRecord?: AgentRecordHandler;
  hostOptions?: AgentHostOptions;
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

/** One conversation: its pi process plus the server's view of it. */
export class Agent {
  readonly id: AgentId;
  readonly cwd: string;
  readonly startedAt: string;
  readonly host: AgentHost;
  status: AgentStatus = "starting";
  attention: Attention = "none";
  /** Last `get_state` data. */
  state: PiSessionState | null = null;

  constructor(id: AgentId, cwd: string, host: AgentHost) {
    this.id = id;
    this.cwd = cwd;
    this.host = host;
    this.startedAt = new Date().toISOString();
  }

  info(): AgentInfo {
    const info: AgentInfo = {
      id: this.id,
      cwd: this.cwd,
      status: this.status,
      isStreaming: this.state?.isStreaming ?? false,
      attention: this.attention,
      startedAt: this.startedAt,
    };
    if (this.state?.sessionFile) info.sessionFile = this.state.sessionFile;
    if (this.state?.sessionId) info.sessionId = this.state.sessionId;
    if (this.state?.sessionName) info.sessionName = this.state.sessionName;
    if (this.status === "exited") {
      const exit = this.host.exitInfo;
      if (typeof exit?.code === "number") info.exitCode = exit.code;
      info.stderrTail = this.host.stderrTail;
    }
    return info;
  }
}

export interface AgentManagerEvents {
  /** An agent's info changed (status transitions). */
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

  constructor(deps: AgentManagerDeps) {
    super();
    this.deps = deps;
    this.onRecord = deps.onRecord;
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
   * Opens a new agent with a new session in `cwd` (must resolve inside `$HOME`). Returns right
   * away with `status: "starting"`; the agent becomes `ready` after its first `get_state`.
   */
  async open(req: { cwd: string }): Promise<Agent> {
    const cwd = await this.resolveCwd(req.cwd);
    const id = this.deps.newId?.() ?? randomBytes(9).toString("base64url");
    const spec = this.deps.command({ cwd });
    const host = AgentHost.spawn(spec.bin, spec.args, {
      cwd,
      ...(spec.env ? { env: spec.env } : {}),
      ...this.deps.hostOptions,
    });
    const agent = new Agent(id, cwd, host);
    this.agents.set(id, agent);

    host.on("event", (event) => this.record(agent, { kind: "event", event }));
    host.on("ui_request", (request) => this.record(agent, { kind: "ui_request", request }));
    host.on("protocol_error", (err) => {
      console.warn(`[agent ${id}] ${err.message}`);
    });
    host.on("exit", (exit) => this.onExit(agent, exit));

    this.publishStatus(agent);
    void this.initialize(agent);
    return agent;
  }

  /** Stops the agent's process and removes it. */
  async close(id: AgentId): Promise<void> {
    const agent = this.require(id);
    await agent.host.close();
    if (this.agents.get(id) === agent) {
      this.agents.delete(id);
      this.emit("closed", id);
    }
  }

  /** Closes every agent in parallel (shutdown). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.agents.keys()].map((id) => this.close(id).catch(() => {})));
  }

  private async initialize(agent: Agent): Promise<void> {
    try {
      const state = await agent.host.send<PiSessionState>({ type: "get_state" });
      if (agent.status !== "starting") return;
      agent.state = state;
      agent.status = "ready";
      this.publishStatus(agent);
    } catch (e) {
      if (agent.host.status === "running") {
        console.warn(`[agent ${agent.id}] initial get_state failed: ${(e as Error).message}`);
      }
    }
  }

  private onExit(agent: Agent, exit: HostExit): void {
    agent.status = "exited";
    if (!exit.requested) {
      const why = exit.error?.message ?? `code ${exit.code}, signal ${exit.signal}`;
      console.warn(`[agent ${agent.id}] pi exited unexpectedly (${why})`);
    }
    this.publishStatus(agent);
  }

  private publishStatus(agent: Agent): void {
    const info = agent.info();
    this.emit("agent", info);
    this.record(agent, { kind: "status", agent: info });
  }

  private record(agent: Agent, record: AgentRecord): void {
    if (!this.onRecord) return;
    try {
      this.onRecord(agent, record);
    } catch (e) {
      console.error(`[agent ${agent.id}] record handler failed:`, e);
    }
  }

  private async resolveCwd(cwd: string): Promise<string> {
    if (typeof cwd !== "string" || !isAbsolute(cwd)) {
      throw new ApiError("invalid_body", "cwd must be an absolute path");
    }
    this.homeReal ??= realpath(this.deps.home);
    const home = await this.homeReal;
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
