/**
 * Test helpers over the recorded pi fixtures (`test/fixtures/*.jsonl`), via the protocol
 * package's fixture → ServerEvent converter.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentInfo,
  applyServerEventToCaches,
  initialLiveState,
  type LiveState,
  reduceLive,
  type ServerEvent,
  type SessionCaches,
  type Snapshot,
  type Transcript,
} from "@pi-code/protocol";
import {
  type FixtureLine,
  fixtureToServerEvents,
} from "../../../protocol/src/testing/fixture-events.ts";

// jsdom's global `URL` mis-resolves relative file URLs, so the protocol helper's URL-based
// loaders don't work here; paths are built with node:path instead.
const FIXTURES_DIR = join(import.meta.dirname, "../../../../test/fixtures");

export function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => file.slice(0, -".jsonl".length))
    .sort();
}

export function loadFixture(name: string): FixtureLine[] {
  return readFileSync(join(FIXTURES_DIR, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as FixtureLine);
}

export function fixtureEvents(name: string): ServerEvent[] {
  return fixtureToServerEvents(loadFixture(name));
}

export function makeAgent(patch: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "a1",
    cwd: "/home/me/project",
    status: "ready",
    isStreaming: false,
    attention: "none",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

export function initialCaches(agent: AgentInfo = makeAgent()): SessionCaches {
  return {
    agent,
    state: null,
    transcript: { entries: [], leafId: null },
    stats: null,
    gitStatus: null,
  };
}

export function reduceAll(events: readonly ServerEvent[], from: LiveState = initialLiveState()) {
  return events.reduce(reduceLive, from);
}

export function applyAll(events: readonly ServerEvent[], from: SessionCaches = initialCaches()) {
  return events.reduce(applyServerEventToCaches, from);
}

/**
 * The fixture's richest transcript: the committed state with the most entries (before any
 * session switch replaced it), as synced from its `get_entries` responses.
 */
export function fixtureTranscript(name: string): Transcript {
  let caches = initialCaches();
  let best = caches.transcript;
  for (const event of fixtureEvents(name)) {
    caches = applyServerEventToCaches(caches, event);
    if (caches.transcript.entries.length >= best.entries.length) best = caches.transcript;
  }
  return best;
}

export function makeSnapshot(patch: Partial<Snapshot> = {}): Snapshot {
  return {
    agent: makeAgent(),
    state: null,
    transcript: { entries: [], leafId: null },
    live: initialLiveState(),
    stats: null,
    gitStatus: null,
    seq: 0,
    ...patch,
  };
}
