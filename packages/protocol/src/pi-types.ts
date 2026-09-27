/**
 * Type-only re-exports of pi's public types used by the protocol.
 * pi's RPC and session types come from `@earendil-works/pi-coding-agent`;
 * LLM message shapes from `@earendil-works/pi-ai`; `AgentMessage` from
 * `@earendil-works/pi-agent-core` (augmented by pi-coding-agent with
 * bashExecution / custom / branchSummary / compactionSummary messages).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RpcResponse, SessionEntry } from "@earendil-works/pi-coding-agent";

export type {
  AgentMessage,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
export type {
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  StopReason,
  SystemMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
export type {
  BashToolDetails,
  BranchSummaryEntry,
  CompactionEntry,
  CompactionResult,
  ContextEditEntry,
  ContextUsage,
  CustomEntry,
  CustomMessageEntry,
  EditToolDetails,
  FindToolDetails,
  GrepToolDetails,
  JsonAgentSessionEvent,
  LsToolDetails,
  ModelChangeEntry,
  ModelInfo,
  ReadToolDetails,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
  SessionEntry,
  SessionHeader,
  SessionInfoEntry,
  SessionMessageEntry,
  SessionStats,
  SessionTreeNode,
  SlashCommandInfo,
  ThinkingLevelChangeEntry,
} from "@earendil-works/pi-coding-agent";

/** `label` session entry (`{ targetId, label }`); not exported by pi under its own name. */
export type LabelEntry = Extract<SessionEntry, { type: "label" }>;

/** `bashExecution` message (user `!` / `!!` commands and the RPC `bash` command). */
export type BashExecutionMessage = Extract<AgentMessage, { role: "bashExecution" }>;

/** Data of a successful pi RPC `bash` response (`{ output, exitCode, cancelled, truncated, fullOutputPath? }`). */
export type BashResult = Extract<RpcResponse, { command: "bash"; success: true }>["data"];
