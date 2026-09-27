import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type {
  AgentId,
  AgentInfo,
  AgentStatus,
  Attention,
  JsonAgentSessionEvent,
  RpcExtensionUIRequest,
  RpcSessionState,
} from "@pi-code/protocol";
import { ApiError } from "../errors.ts";
import { AgentHost, type AgentHostOptions, type HostExit } from "./agent-host.ts";
import { AgentPipeline, type AttentionTrigger } from "./pipeline.ts";

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
 * Per-agent records, in stdout order, as observed before they enter the agent's pipeline.
 * `status` records follow every published `agent_status` (status or attention changes).
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
  /** Observes every agent record; replaceable later with `setRecordHandler`. */
  onRecord?: AgentRecordHandler;
  /** Notification triggers (finished / failed / input), for push (S12). */
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
  readonly host: AgentHost;
  status: AgentStatus = "starting";
  attention: Attention = "none";
  /** Cached `get_state` data (kept current by the pipeline). */
  state: RpcSessionState | null = null;
  readonly pipeline: AgentPipeline;

  constructor(
    id: AgentId,
    cwd: string,
    host: AgentHost,
    pipelineOptions: ConstructorParameters<typeof AgentPipeline>[1] = {},
  ) {
    this.id = id;
    this.cwd = cwd;
    this.host = host;
    this.startedAt = new Date().toISOString();
    this.pipeline = new AgentPipeline(this, pipelineOptions);
  }

  info(): AgentInfo {
    const info: AgentInfo = {
      id: this.id,
      cwd: this.cwd,
      status: this.status,
      isStreaming: this.status !== "exited" && (this.state?.isStreaming ?? false),
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
  /** An agent's info changed (status or attention). */
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

  /** The agent (other than `except`) that has `sessionFile` open, if any. */
  ownerOf(sessionFile: string, except?: AgentId): AgentId | undefined {
    for (const agent of this.agents.values()) {
      if (
        agent.id !== except &&
        agent.status !== "exited" &&
        agent.state?.sessionFile === sessionFile
      ) {
        return agent.id;
      }
    }
    return undefined;
  }

  /**
   * Opens a new agent with a new session in `cwd` (must resolve inside `$HOME`). Returns right
   * away with `status: "starting"`; the pipeline makes it `ready` once state and transcript are
   * loaded.
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
    const agent: Agent = new Agent(id, cwd, host, {
      ...(this.deps.eventLogCapacity ? { eventLogCapacity: this.deps.eventLogCapacity } : {}),
      onAgentInfo: (info) => {
        this.emit("agent", info);
        this.record(agent, { kind: "status", agent: info });
      },
      onTrigger: (trigger) => this.deps.onTrigger?.(trigger),
    });
    this.agents.set(id, agent);

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
    host.on("exit", (exit) => this.onExit(agent, exit));

    agent.pipeline.start();
    return agent;
  }

  /** Stops the agent's process and removes it. */
  async close(id: AgentId): Promise<void> {
    const agent = this.require(id);
    await agent.host.close();
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
