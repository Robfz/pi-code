import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { ApiError } from "../errors.ts";
import type { PiCommand, PiEvent, PiResponse, PiUiRequest, PiUiResponse } from "../types-temp.ts";
import { LineSplitter } from "./jsonl.ts";

/** `running` → `closing` (after `close()`) → `exited`; or `running` → `exited` on a crash. */
export type HostStatus = "running" | "closing" | "exited";

export interface HostExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Spawn failure (e.g. ENOENT), if that's why the process is gone. */
  error?: Error;
  /** Whether the exit followed `close()`. */
  requested: boolean;
}

export interface HostProtocolError {
  message: string;
  line?: string;
  record?: unknown;
}

export interface AgentHostEvents {
  /** Every stdout record that isn't a response or an extension UI request (pi session events). */
  event: [PiEvent];
  /** `extension_ui_request` records. */
  ui_request: [PiUiRequest];
  /** One stderr line (diagnostics only). */
  stderr: [string];
  /** Unparseable stdout lines, id-less responses (`parse` errors), responses to unknown ids. */
  protocol_error: [HostProtocolError];
  status: [HostStatus];
  exit: [HostExit];
}

export interface AgentHostOptions {
  /** How long `send` waits for the matching response. Default 60 s. */
  commandTimeoutMs?: number;
  /** `close()` sends SIGTERM after this long. Default 5 s. */
  closeTermMs?: number;
  /** `close()` sends SIGKILL after this long. Default 10 s. */
  closeKillMs?: number;
  /** Lines of stderr kept. Default 200. */
  stderrTailLines?: number;
  /** Prefix of generated command ids. Default `pc-`. */
  idPrefix?: string;
}

export interface SpawnOptions extends AgentHostOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface Pending {
  command: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** After `exit`, how long to wait for stdio to close before finalizing anyway. */
const EXIT_GRACE_MS = 2_000;

/**
 * One `pi --mode rpc` child process: JSONL framing, command/response correlation, routing of
 * events and extension UI requests, stderr tail, and the close escalation.
 */
export class AgentHost extends EventEmitter<AgentHostEvents> {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly commandTimeoutMs: number;
  private readonly closeTermMs: number;
  private readonly closeKillMs: number;
  private readonly stderrTailLines: number;
  private readonly idPrefix: string;

  private _status: HostStatus = "running";
  private _exit: HostExit | undefined;
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private readonly stderrLines: string[] = [];

  private readonly writeQueue: string[] = [];
  private writeBlocked = false;
  private endAfterFlush = false;

  private closeTimers: NodeJS.Timeout[] = [];
  private exitGraceTimer: NodeJS.Timeout | undefined;
  private closeRequested = false;
  private readonly exitPromise: Promise<HostExit>;
  private resolveExit!: (exit: HostExit) => void;

  /** Spawns `bin args` with piped stdio. */
  static spawn(bin: string, args: readonly string[], opts: SpawnOptions): AgentHost {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new AgentHost(child, opts);
  }

  constructor(child: ChildProcessWithoutNullStreams, opts: AgentHostOptions = {}) {
    super();
    this.child = child;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 60_000;
    this.closeTermMs = opts.closeTermMs ?? 5_000;
    this.closeKillMs = opts.closeKillMs ?? 10_000;
    this.stderrTailLines = opts.stderrTailLines ?? 200;
    this.idPrefix = opts.idPrefix ?? "pc-";
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    const stdout = new LineSplitter((line) => this.onStdoutLine(line));
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stdout.on("end", () => stdout.end());
    child.stdout.on("error", () => {});

    const stderr = new LineSplitter((line) => this.onStderrLine(line));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stderr.on("end", () => stderr.end());
    child.stderr.on("error", () => {});

    // EPIPE etc. when the child is gone; the exit handling takes care of the rest.
    child.stdin.on("error", () => {});

    child.on("error", (error) => {
      if (child.pid === undefined) this.finalize(null, null, error);
    });
    child.on("exit", () => {
      this.exitGraceTimer ??= setTimeout(() => {
        this.finalize(child.exitCode, child.signalCode);
      }, EXIT_GRACE_MS);
    });
    child.on("close", (code, signal) => this.finalize(code, signal));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get status(): HostStatus {
    return this._status;
  }

  /** Exit details once `status` is `exited`. */
  get exitInfo(): HostExit | undefined {
    return this._exit;
  }

  /** Last stderr lines (at most `stderrTailLines`). */
  get stderrTail(): string[] {
    return [...this.stderrLines];
  }

  /** Resolves when the process is gone (never rejects). */
  get exited(): Promise<HostExit> {
    return this.exitPromise;
  }

  /**
   * Sends a command and resolves with pi's `response.data`. Rejects with an `ApiError`:
   * `pi_error` (pi answered `success: false`), `pi_timeout`, or `agent_exited`.
   */
  send<T = unknown>(command: PiCommand, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (this._status !== "running") {
      return Promise.reject(this.notRunningError());
    }
    this.nextId += 1;
    const id = `${this.idPrefix}${this.nextId}`;
    const line = `${JSON.stringify({ ...command, id })}\n`;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.commandTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ApiError(
            "pi_timeout",
            `pi did not answer ${command.type} within ${Math.round(timeoutMs / 1000)} s`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        command: command.type,
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });
      this.write(line);
    });
  }

  /** Writes a record that gets no response (`extension_ui_response`). */
  sendNoReply(record: PiUiResponse): void {
    if (this._status !== "running") throw this.notRunningError();
    this.write(`${JSON.stringify(record)}\n`);
  }

  /**
   * Ends stdin (pi disposes and exits), then SIGTERM after `closeTermMs` and SIGKILL after
   * `closeKillMs`. Resolves when the process is gone.
   */
  close(): Promise<HostExit> {
    if (this._status === "running") {
      this.closeRequested = true;
      this.setStatus("closing");
      if (this.writeBlocked) this.endAfterFlush = true;
      else this.child.stdin.end();
      this.closeTimers = [
        setTimeout(() => this.kill("SIGTERM"), this.closeTermMs),
        setTimeout(() => this.kill("SIGKILL"), this.closeKillMs),
      ];
    }
    return this.exitPromise;
  }

  private kill(signal: NodeJS.Signals): void {
    if (this._status === "exited") return;
    try {
      this.child.kill(signal);
    } catch {
      // already gone
    }
  }

  private notRunningError(): ApiError {
    return new ApiError(
      "agent_exited",
      this._status === "closing" ? "pi is shutting down" : this.exitMessage(),
    );
  }

  private exitMessage(): string {
    const exit = this._exit;
    if (!exit) return "pi has exited";
    if (exit.error) return `pi failed to start: ${exit.error.message}`;
    if (exit.signal) return `pi exited (signal ${exit.signal})`;
    return `pi exited (code ${exit.code})`;
  }

  private write(line: string): void {
    if (this.writeBlocked) {
      this.writeQueue.push(line);
      return;
    }
    if (!this.child.stdin.write(line)) this.waitForDrain();
  }

  private waitForDrain(): void {
    this.writeBlocked = true;
    this.child.stdin.once("drain", this.onDrain);
  }

  private readonly onDrain = (): void => {
    this.writeBlocked = false;
    while (this.writeQueue.length > 0) {
      const line = this.writeQueue.shift() as string;
      if (!this.child.stdin.write(line)) {
        this.waitForDrain();
        return;
      }
    }
    if (this.endAfterFlush) {
      this.endAfterFlush = false;
      this.child.stdin.end();
    }
  };

  private onStdoutLine(line: string): void {
    if (line.trim().length === 0) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (e) {
      this.safeEmit("protocol_error", {
        message: `unparseable stdout line: ${(e as Error).message}`,
        line,
      });
      return;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      this.safeEmit("protocol_error", { message: "stdout record is not an object", record });
      return;
    }
    const type = (record as { type?: unknown }).type;
    if (type === "response") this.onResponse(record as PiResponse);
    else if (type === "extension_ui_request") this.safeEmit("ui_request", record as PiUiRequest);
    else this.safeEmit("event", record as PiEvent);
  }

  private onResponse(response: PiResponse): void {
    const pending = typeof response.id === "string" ? this.pending.get(response.id) : undefined;
    if (!pending) {
      this.safeEmit("protocol_error", {
        message:
          typeof response.id === "string"
            ? `response to unknown id ${response.id}`
            : `response without id: ${response.error ?? response.command}`,
        record: response,
      });
      return;
    }
    this.pending.delete(response.id as string);
    clearTimeout(pending.timer);
    if (response.success) pending.resolve(response.data);
    else pending.reject(new ApiError("pi_error", response.error ?? `${pending.command} failed`));
  }

  private onStderrLine(line: string): void {
    this.stderrLines.push(line);
    if (this.stderrLines.length > this.stderrTailLines) {
      this.stderrLines.splice(0, this.stderrLines.length - this.stderrTailLines);
    }
    this.safeEmit("stderr", line);
  }

  private finalize(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this._status === "exited") return;
    clearTimeout(this.exitGraceTimer);
    for (const t of this.closeTimers) clearTimeout(t);
    this.closeTimers = [];
    this.writeQueue.length = 0;
    this._exit = { code, signal, requested: this.closeRequested, ...(error ? { error } : {}) };
    this.setStatus("exited");
    const err = new ApiError("agent_exited", this.exitMessage());
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.safeEmit("exit", this._exit);
    this.resolveExit(this._exit);
  }

  private setStatus(status: HostStatus): void {
    this._status = status;
    this.safeEmit("status", status);
  }

  /** Listener failures must not break the stdout reader or the exit handling. */
  private safeEmit<K extends keyof AgentHostEvents>(event: K, ...args: AgentHostEvents[K]): void {
    try {
      (this.emit as (e: K, ...a: AgentHostEvents[K]) => boolean)(event, ...args);
    } catch (e) {
      console.error(`[agent-host] ${String(event)} listener failed:`, e);
    }
  }
}
