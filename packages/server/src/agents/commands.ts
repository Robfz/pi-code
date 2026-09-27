import {
  type AgentId,
  isAllowedRpcCommandType,
  type RpcCommandBody,
  type UiResponseBody,
} from "@pi-code/protocol";
import { ApiError } from "../errors.ts";
import type { Agent } from "./agent-manager.ts";
import { SESSION_CHANGING_COMMANDS } from "./pipeline.ts";

/** Prefix of the pi-code extension's own commands (hidden from `get_commands`). */
const PI_CODE_COMMAND_PREFIX = "pi-code-";

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

export interface CommandContext {
  /** The other agent that has `sessionFile` open, if any. */
  ownerOf(sessionFile: string, except: AgentId): AgentId | undefined;
}

export type CommandOutcome = { status: 200; data: unknown } | { status: 202; data: { id: string } };

/** Rejects requests for agents that can't take them. */
export function assertAcceptsInput(agent: Agent): void {
  if (agent.status === "exited" || agent.host.status !== "running") {
    throw new ApiError("agent_exited", "pi has exited; restart the agent");
  }
  if (agent.status === "awaiting_trust") {
    throw new ApiError("agent_busy", "the agent is waiting for the project-trust decision");
  }
}

/**
 * Runs a pi command for `POST /api/agents/:id/rpc` with the contract's rules, and queues its
 * pipeline side effects (resolved before returning). `bash` returns `202 { id }` right away.
 */
export async function runCommand(
  agent: Agent,
  command: RpcCommandBody,
  ctx: CommandContext,
): Promise<CommandOutcome> {
  assertAcceptsInput(agent);
  const pipeline = agent.pipeline;
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

  const execute = async (): Promise<CommandOutcome> => {
    const data = await agent.host.send(command, sendOptions(command));
    await pipeline.afterCommand(command.type, data);
    return {
      status: 200,
      data: command.type === "get_commands" ? withoutPiCodeCommands(data) : data,
    };
  };
  return SESSION_CHANGING_COMMANDS.has(command.type) ? pipeline.exclusive(execute) : execute();
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
