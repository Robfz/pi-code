import {
  type AgentId,
  isAllowedRpcCommandType,
  type NavigateBody,
  type NavigateResponse,
  type RpcCommandBody,
  type UiResponseBody,
} from "@pi-code/protocol";
import { ApiError } from "../errors.ts";
import type { Agent } from "./agent-manager.ts";
import { SESSION_CHANGING_COMMANDS } from "./pipeline.ts";

/** Prefix of the pi-code extension's own commands (hidden from `get_commands`). */
const PI_CODE_COMMAND_PREFIX = "pi-code-";

/** The pi-code extension's tree-navigation command (see packages/pi-extension). */
const TREE_COMMAND = "pi-code-tree";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a `POST /rpc` body: an allowlisted pi command; a client-sent `id` is dropped. */
export function parseRpcCommand(value: unknown): RpcCommandBody {
  if (!isObject(value) || typeof value.type !== "string") {
    throw new ApiError("invalid_body", "expected a pi command: { type: string, … }");
  }
  if (!isAllowedRpcCommandType(value.type)) {
    throw new ApiError("command_not_allowed", `command not allowed: ${value.type}`);
  }
  const { id: _id, ...command } = value;
  if (command.type === "prompt" && command.streamingBehavior !== undefined) {
    if (command.streamingBehavior !== "steer" && command.streamingBehavior !== "followUp") {
      throw new ApiError("invalid_body", 'streamingBehavior must be "steer" or "followUp"');
    }
  }
  if (command.type === "bash" && typeof command.command !== "string") {
    throw new ApiError("invalid_body", "bash needs a command string");
  }
  if (command.type === "switch_session" && typeof command.sessionPath !== "string") {
    throw new ApiError("invalid_body", "switch_session needs a sessionPath string");
  }
  return command as RpcCommandBody;
}

/** Validates a `POST /ui-responses` body. */
export function parseUiResponse(value: unknown): UiResponseBody {
  if (isObject(value) && typeof value.id === "string") {
    const keys = Object.keys(value).filter((k) => k !== "id");
    if (keys.length === 1) {
      if (typeof value.value === "string") return { id: value.id, value: value.value };
      if (typeof value.confirmed === "boolean") {
        return { id: value.id, confirmed: value.confirmed };
      }
      if (value.cancelled === true) return { id: value.id, cancelled: true };
    }
  }
  throw new ApiError(
    "invalid_body",
    "expected { id, value: string } | { id, confirmed: boolean } | { id, cancelled: true }",
  );
}

interface CommandContext {
  /** The other agent that has `sessionFile` open, if any. */
  ownerOf(sessionFile: string, except: AgentId): AgentId | undefined;
  /** A session file's realpath, confined like `POST /api/agents { sessionFile }`. */
  resolveSessionFile(sessionFile: string): Promise<string>;
  /** A `clone` moved the agent from session file `from` to its copy `to`. */
  onSessionCopied?(from: string, to: string): Promise<void>;
  /** Whether `sessionFile` has a PR attachment. */
  isPrAttached?(sessionFile: string): boolean;
}

type CommandOutcome = { status: 200; data: unknown } | { status: 202; data: { id: string } };

/**
 * Rejects tree navigation and forks of a conversation attached to a PR: the attachment is per
 * session file, but the agent's PR context is on one branch of its tree.
 */
function assertNotPrAttached(agent: Agent, isPrAttached?: (sessionFile: string) => boolean): void {
  const file = agent.sessionFile;
  if (file !== undefined && isPrAttached?.(file)) {
    throw new ApiError(
      "pr_attached",
      "a conversation attached to a PR can't navigate its tree or fork; /clone it instead",
    );
  }
}

/** Rejects requests for agents that can't take them. */
export function assertAcceptsInput(agent: Agent): void {
  if (agent.status === "awaiting_trust") {
    throw new ApiError("agent_busy", "the agent is waiting for the project-trust decision");
  }
  if (agent.status === "exited" || !agent.hasHost || agent.host.status !== "running") {
    throw new ApiError("agent_exited", "pi has exited; restart the agent");
  }
}

/**
 * Runs a pi command for `POST /api/agents/:id/rpc` with the contract's rules, and queues its
 * pipeline side effects (resolved before returning). `bash` returns `202 { id }` right away.
 */
export async function runCommand(
  agent: Agent,
  body: RpcCommandBody,
  ctx: CommandContext,
): Promise<CommandOutcome> {
  assertAcceptsInput(agent);
  const pipeline = agent.pipeline;
  let command = body;
  if (command.type === "switch_session") {
    command = { ...command, sessionPath: await ctx.resolveSessionFile(command.sessionPath) };
    assertAcceptsInput(agent);
  }
  switch (command.type) {
    case "prompt":
      if (command.streamingBehavior === undefined && pipeline.isStreaming()) {
        throw new ApiError(
          "streaming_behavior_required",
          'the agent is running: set streamingBehavior to "steer" or "followUp"',
        );
      }
      break;
    case "switch_session": {
      // `sessionPath` is canonical here, like the session files agents own.
      const owner = ctx.ownerOf(command.sessionPath, agent.id);
      if (owner !== undefined) {
        throw new ApiError("session_owned", `session is open in agent ${owner}`);
      }
      break;
    }
    case "bash":
      return { status: 202, data: { id: pipeline.startBash(command) } };
    default:
      break;
  }

  const sessionChanging = SESSION_CHANGING_COMMANDS.has(command.type);
  // `/pi-code-tree` moves the leaf like `POST /tree/navigate` (parsed like pi does).
  const treePrompt =
    command.type === "prompt" && command.message.split(" ", 1)[0] === `/${TREE_COMMAND}`;
  const execute = async (): Promise<CommandOutcome> => {
    // Checked once the session lock is held: a queued session switch changes `sessionFile`.
    if (command.type === "fork" || treePrompt) assertNotPrAttached(agent, ctx.isPrAttached);
    if (sessionChanging) pipeline.beginUiRefresh();
    const before = agent.sessionFile;
    const data = await agent.host.send(command, sendOptions(command));
    await pipeline.afterCommand(command.type, data);
    const after = agent.sessionFile;
    if (
      command.type === "clone" &&
      before !== undefined &&
      after !== undefined &&
      after !== before
    ) {
      // The clone is done either way; a failed copy shouldn't report it as failed.
      await ctx.onSessionCopied?.(before, after).catch((e: unknown) => {
        console.warn(`[agent ${agent.id}] onSessionCopied failed for ${after}:`, e);
      });
    }
    return {
      status: 200,
      data: command.type === "get_commands" ? withoutPiCodeCommands(data) : data,
    };
  };
  return sessionChanging || treePrompt ? pipeline.exclusive(execute) : execute();
}

/** Validates a `POST /tree/navigate` body. */
export function parseNavigateBody(value: unknown): NavigateBody {
  if (
    isObject(value) &&
    typeof value.entryId === "string" &&
    value.entryId !== "" &&
    typeof value.summarize === "boolean" &&
    (value.customInstructions === undefined || typeof value.customInstructions === "string")
  ) {
    const body: NavigateBody = { entryId: value.entryId, summarize: value.summarize };
    if (value.customInstructions !== undefined) body.customInstructions = value.customInstructions;
    return body;
  }
  throw new ApiError(
    "invalid_body",
    "expected { entryId: string, summarize: boolean, customInstructions?: string }",
  );
}

/**
 * Makes sure this pi process has the pi-code extension loaded. Without it, `/pi-code-tree …`
 * would reach the model as a plain prompt.
 */
async function assertTreeCommand(agent: Agent): Promise<void> {
  if (agent.hasTreeCommand) return;
  const data = await agent.host.send<{ commands?: unknown }>({ type: "get_commands" });
  const commands = isObject(data) && Array.isArray(data.commands) ? data.commands : [];
  agent.hasTreeCommand = commands.some((c: unknown) => isObject(c) && c.name === TREE_COMMAND);
  if (!agent.hasTreeCommand) {
    throw new ApiError(
      "internal",
      `tree navigation needs the pi-code extension, but pi has no ${TREE_COMMAND} command (was pi started with --extension packages/pi-extension/src/index.ts?)`,
    );
  }
}

/**
 * In-place tree navigation (`POST /tree/navigate`) through the pi-code extension's
 * `/pi-code-tree` command. pi answers the prompt once the navigation (and its optional branch
 * summary) is done; the server then syncs the moved leaf (`entries_appended`, see
 * `syncAfterNavigation`) and answers with the resulting `leafId` and the `seq` its events were
 * published up to. `cancelled` when the leaf didn't move. A failing navigation surfaces as pi's
 * `extension_error` → `pi_error`, after the sync. `pr_attached` when the conversation is
 * attached to a PR.
 */
export async function navigateTree(
  agent: Agent,
  body: NavigateBody,
  isPrAttached?: (sessionFile: string) => boolean,
): Promise<NavigateResponse> {
  assertAcceptsInput(agent);
  assertNotPrAttached(agent, isPrAttached);
  const pipeline = agent.pipeline;
  const assertIdle = () => {
    if (pipeline.isStreaming()) {
      throw new ApiError("agent_busy", "the agent is running; wait for it to finish or abort it");
    }
  };
  assertIdle();
  if (!pipeline.transcript.entries.some((e) => e.id === body.entryId)) {
    throw new ApiError("invalid_body", `no entry ${body.entryId} in this session`);
  }
  return pipeline.exclusive(async () => {
    assertAcceptsInput(agent);
    assertNotPrAttached(agent, isPrAttached);
    assertIdle();
    await assertTreeCommand(agent);
    const host = agent.host;
    const leafBefore = pipeline.transcript.leafId;
    let failure: string | undefined;
    const onEvent = (event: { type: string }) => {
      const e = event as { type: string; extensionPath?: unknown; error?: unknown };
      if (e.type === "extension_error" && e.extensionPath === `command:${TREE_COMMAND}`) {
        failure = typeof e.error === "string" ? e.error : "tree navigation failed";
      }
    };
    host.on("event", onEvent);
    try {
      const args = JSON.stringify(body);
      await host.send(
        { type: "prompt", message: `/${TREE_COMMAND} ${args}` },
        { timeoutMs: Number.POSITIVE_INFINITY },
      );
    } finally {
      host.off("event", onEvent);
    }
    await pipeline.syncAfterNavigation();
    if (failure !== undefined) throw new ApiError("pi_error", failure);
    const leafId = pipeline.transcript.leafId;
    return { cancelled: leafId === leafBefore, leafId, seq: pipeline.seq };
  });
}

/**
 * pi answers a `prompt` that runs an extension command (`/name …`) only once the command's
 * handler returns, which can take arbitrarily long (e.g. it waits for a dialog answer), so
 * those prompts get no response timeout. Other prompts are answered on acceptance.
 */
function sendOptions(command: RpcCommandBody): { timeoutMs?: number } {
  if (command.type === "prompt" && command.message.trimStart().startsWith("/")) {
    return { timeoutMs: Number.POSITIVE_INFINITY };
  }
  return {};
}

function withoutPiCodeCommands(data: unknown): unknown {
  if (!isObject(data) || !Array.isArray(data.commands)) return data;
  return {
    ...data,
    commands: data.commands.filter(
      (c: unknown) =>
        !(isObject(c) && typeof c.name === "string" && c.name.startsWith(PI_CODE_COMMAND_PREFIX)),
    ),
  };
}
