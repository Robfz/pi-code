# Plan — protocol package

`packages/protocol`. Design: `design/02-api-contract.md`.

## P1 — Types

- Re-export pi types (type-only): `RpcCommand`, `RpcResponse`, `RpcSessionState`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`, `JsonAgentSessionEvent`, `ModelInfo`, message and session-entry types, tool detail types that pi exports.
- Define the contract types: `AgentInfo`, `SessionSummary`, `ProjectSummary`, `GitStatus`, `GitFileDiff`, `Transcript`, `Snapshot`, `ServerEvent`, `UiResponseBody`, `NavigateBody`, `PushPayload`, `ApiError` + error codes, the RPC command allowlist as a const array.
- Done when: server and web both compile against it; a type test asserts the allowlist is a subset of `RpcCommand["type"]`.

## P2 — Reducer: streaming text

- `initialLiveState`, `reduceLive(state, event)` covering `agent_start`, `agent_settled`, `message_start/update/end` for text and thinking blocks, `entries_appended`, `transcript_reset`.
- Done when: the "plain answer" fixture reduces to an empty `streaming` after `message_end` and matches the snapshot; prefix/snapshot/rest invariant holds at every event index.

## P3 — Reducer: everything else

- Tool-call streaming blocks (`toolcall_start/delta/end`), `tool_execution_start/update/end`, `queue_update`, `compaction_start/end`, `auto_retry_start/end`, `thinking_level_changed`, `session_info_changed`.
- `ui_request` (dialogs with `expiresAt`; fire-and-forget → statuses / widgets / title / editorText / notices, notices capped at 20), `ui_resolved`, `curator`, `bash_output`, `bash_done`.
- Done when: every fixture passes the invariant test; unit tests for each event type, including unknown event types being ignored.
