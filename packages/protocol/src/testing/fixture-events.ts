/**
 * Test helper: turns a recorded pi RPC fixture (`test/fixtures/*.jsonl`) into the `ServerEvent`
 * stream the server's pipeline would publish for it.
 *
 * - pi session events → `{ type: "pi", event, receivedAt }`.
 * - `extension_ui_request` → `ui_request` (dialogs and fire-and-forget alike). A dialog is
 *   resolved (`ui_resolved`) when the recorded `extension_ui_response` goes in, or once its
 *   `timeout` has elapsed on the fixture clock (pi sends nothing on expiry; the server's timer does).
 * - `bash_execution_update` → `bash_output`; the `bash` response → `bash_done`.
 * - `get_entries` responses → `entries_appended` with the entries not seen yet, or
 *   `transcript_reset` when a full list no longer extends the known one (session switch).
 * - `get_state` / `get_session_stats` responses → `state` / `stats`.
 * - Other responses, commands and stderr are dropped.
 */

import { readdirSync, readFileSync } from "node:fs";
import type {
  BashResult,
  JsonAgentSessionEvent,
  RpcExtensionUIRequest,
  RpcSessionState,
  SessionEntry,
  SessionStats,
} from "../pi-types.ts";
import type { ServerEvent, Transcript } from "../types.ts";

export interface FixtureLine {
  t: number;
  dir: "in" | "out" | "err";
  line: unknown;
}

const FIXTURES_DIR = new URL("../../../../test/fixtures/", import.meta.url);

export function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => file.slice(0, -".jsonl".length))
    .sort();
}

export function loadFixture(name: string): FixtureLine[] {
  return readFileSync(new URL(`${name}.jsonl`, FIXTURES_DIR), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as FixtureLine);
}

type RawRecord = { type?: unknown; id?: unknown; [key: string]: unknown };

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export function fixtureToServerEvents(lines: readonly FixtureLine[]): ServerEvent[] {
  const events: ServerEvent[] = [];
  const commands = new Map<string, RawRecord>();
  const dialogs = new Map<string, number>(); // id → expiresAt (Infinity without timeout)
  let transcript: Transcript = { entries: [], leafId: null };
  let latestState: RpcSessionState | null = null;

  const expireDialogs = (now: number) => {
    const expired = [...dialogs].filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1]);
    for (const [id] of expired) {
      dialogs.delete(id);
      events.push({ type: "ui_resolved", id });
    }
  };

  const stateFor = (index: number): RpcSessionState => {
    if (latestState) return latestState;
    for (const later of lines.slice(index)) {
      const rec = later.line as RawRecord;
      if (rec?.type === "response" && rec.command === "get_state" && rec.success) {
        return rec.data as RpcSessionState;
      }
    }
    throw new Error("fixture has no get_state response");
  };

  const syncEntries = (index: number, data: Transcript, since: string | undefined) => {
    const knownIds = transcript.entries.map((e) => e.id);
    let fresh: SessionEntry[];
    if (since !== undefined) {
      const known = new Set(knownIds);
      fresh = data.entries.filter((e) => !known.has(e.id));
    } else if (knownIds.every((id, i) => data.entries[i]?.id === id)) {
      fresh = data.entries.slice(knownIds.length);
    } else {
      transcript = { entries: data.entries, leafId: data.leafId };
      events.push({ type: "transcript_reset", transcript, state: stateFor(index) });
      return;
    }
    if (fresh.length === 0 && data.leafId === transcript.leafId) return;
    transcript = { entries: [...transcript.entries, ...fresh], leafId: data.leafId };
    events.push({ type: "entries_appended", entries: fresh, leafId: data.leafId });
  };

  lines.forEach((entry, index) => {
    expireDialogs(entry.t);
    const rec = entry.line as RawRecord;
    if (entry.dir === "err" || typeof rec !== "object" || rec === null) return;

    if (entry.dir === "in") {
      if (typeof rec.id === "string") commands.set(rec.id, rec);
      if (
        rec.type === "extension_ui_response" &&
        typeof rec.id === "string" &&
        dialogs.has(rec.id)
      ) {
        dialogs.delete(rec.id);
        events.push({ type: "ui_resolved", id: rec.id });
      }
      return;
    }

    switch (rec.type) {
      case "response": {
        if (!rec.success) return;
        const command = typeof rec.id === "string" ? commands.get(rec.id) : undefined;
        switch (rec.command) {
          case "get_entries":
            syncEntries(index, rec.data as Transcript, command?.since as string | undefined);
            return;
          case "get_state":
            latestState = rec.data as RpcSessionState;
            events.push({ type: "state", state: latestState });
            return;
          case "get_session_stats":
            events.push({ type: "stats", stats: rec.data as SessionStats });
            return;
          case "bash":
            events.push({
              type: "bash_done",
              id: rec.id as string,
              result: rec.data as BashResult,
              command: command?.command as string,
            });
            return;
          default:
            return;
        }
      }
      case "extension_ui_request": {
        const request = rec as unknown as RpcExtensionUIRequest;
        events.push({ type: "ui_request", request, receivedAt: entry.t });
        if (DIALOG_METHODS.has(request.method)) {
          const timeout = "timeout" in request ? request.timeout : undefined;
          dialogs.set(request.id, timeout ? entry.t + timeout : Number.POSITIVE_INFINITY);
        }
        return;
      }
      case "bash_execution_update": {
        const id = rec.id as string;
        events.push({
          type: "bash_output",
          id,
          delta: rec.delta as string,
          command: commands.get(id)?.command as string,
        });
        return;
      }
      default:
        events.push({
          type: "pi",
          event: rec as unknown as JsonAgentSessionEvent,
          receivedAt: entry.t,
        });
    }
  });
  expireDialogs(Number.MAX_VALUE); // timed-out dialogs; unanswered ones without timeout stay
  return events;
}
