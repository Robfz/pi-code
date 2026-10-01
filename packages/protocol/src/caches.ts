import type { RpcSessionState, SessionEntry, SessionStats } from "./pi-types.ts";
import type { AgentInfo, GitStatus, ServerEvent, Transcript } from "./types.ts";

/**
 * Committed session state that server and client keep next to `LiveState`
 * (the non-live half of a `Snapshot`).
 */
export interface SessionCaches {
  agent: AgentInfo;
  state: RpcSessionState | null;
  transcript: Transcript;
  stats: SessionStats | null;
  gitStatus: GitStatus | null;
}

/**
 * Apply one server event to the committed caches. Pure; returns `caches` itself when the event
 * changes nothing, otherwise a shallow copy where only the touched fields are replaced (extra
 * fields of `C`, e.g. a store's `live` or `seq`, are carried over untouched).
 *
 * - `entries_appended` → appends entries not already present (by id) and moves `leafId`.
 * - `transcript_reset` → replaces `transcript` and `state`.
 * - `state` / `stats` / `git_status` / `agent_status` → replace `state` / `stats` / `gitStatus` / `agent`.
 * - `state` and `transcript_reset` also copy `sessionFile` / `sessionId` / `sessionName` into `agent`.
 * - pi events patch the cached `state` between `state` events: `thinking_level_changed`
 *   (`thinkingLevel`), `session_info_changed` (`sessionName`, also on `agent`), `agent_start` /
 *   `agent_settled` (`isStreaming`, also on `agent`), `compaction_start` / `compaction_end`
 *   (`isCompacting`), `queue_update` (`pendingMessageCount`).
 *
 * Everything else (live-only events, unknown types) returns `caches` unchanged.
 * Server and client both run it after `reduceLive` for every published event.
 */
export function applyServerEventToCaches<C extends SessionCaches>(
  caches: C,
  event: ServerEvent,
): C {
  switch (event.type) {
    case "entries_appended": {
      const known = new Set(caches.transcript.entries.map((e) => e.id));
      const fresh = event.entries.filter((e) => !known.has(e.id));
      if (fresh.length === 0 && event.leafId === caches.transcript.leafId) return caches;
      const entries =
        fresh.length === 0 ? caches.transcript.entries : [...caches.transcript.entries, ...fresh];
      return { ...caches, transcript: { entries, leafId: event.leafId } };
    }
    case "transcript_reset":
      return withSessionFields(
        { ...caches, transcript: event.transcript, state: event.state },
        event.state,
      );
    case "state":
      return withSessionFields({ ...caches, state: event.state }, event.state);
    case "stats":
      return { ...caches, stats: event.stats };
    case "git_status":
      return { ...caches, gitStatus: event.status };
    case "agent_status":
      return { ...caches, agent: event.agent };
    case "pi": {
      const pi = event.event;
      switch (pi.type) {
        case "thinking_level_changed":
          return patchState(caches, { thinkingLevel: pi.level });
        case "session_info_changed": {
          const next = patchState(caches, { sessionName: pi.name });
          return patchAgent(next, { sessionName: pi.name });
        }
        case "agent_start":
        case "agent_settled": {
          const isStreaming = pi.type === "agent_start";
          return patchAgent(patchState(caches, { isStreaming }), { isStreaming });
        }
        case "compaction_start":
        case "compaction_end":
          return patchState(caches, { isCompacting: pi.type === "compaction_start" });
        case "queue_update":
          return patchState(caches, {
            pendingMessageCount: pi.steering.length + pi.followUp.length,
          });
        default:
          return caches;
      }
    }
    default:
      return caches;
  }
}

/**
 * The active branch: entries from the root to `leafId`, following `parentId`.
 * Empty when `leafId` is null or unknown.
 */
export function activeBranch(transcript: Transcript): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  for (const entry of transcript.entries) byId.set(entry.id, entry);
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  let id = transcript.leafId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const entry = byId.get(id);
    if (entry === undefined) break;
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}

function patchState<C extends SessionCaches>(caches: C, patch: Partial<RpcSessionState>): C {
  const state = caches.state;
  if (state === null) return caches;
  if (!differs(state, patch)) return caches;
  return { ...caches, state: { ...state, ...patch } };
}

function patchAgent<C extends SessionCaches>(caches: C, patch: Partial<AgentInfo>): C {
  if (!differs(caches.agent, patch)) return caches;
  return { ...caches, agent: { ...caches.agent, ...patch } };
}

function withSessionFields<C extends SessionCaches>(caches: C, state: RpcSessionState): C {
  return patchAgent(caches, {
    sessionFile: state.sessionFile,
    sessionId: state.sessionId,
    sessionName: state.sessionName,
  });
}

function differs<T extends object>(target: T, patch: Partial<T>): boolean {
  return (Object.keys(patch) as (keyof T)[]).some((key) => target[key] !== patch[key]);
}
