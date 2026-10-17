/**
 * Static invariants a fixture must satisfy for the fake pi and the server to replay it the way
 * real pi runs: a broken entry chain or a `role:timestamp` mismatch makes the server fall back to
 * `transcript_reset`, which would hide missing content instead of failing a test.
 */
import type { FixtureLine } from "../../../test/fake-pi.ts";

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const keyOf = (m: Rec) => `${String(m.role)}:${String(m.timestamp)}`;

/** Throws an error naming the first broken invariant. */
export function checkFixture(lines: FixtureLine[], expected: { sessionFile: string }): void {
  const fail = (index: number, why: string): never => {
    throw new Error(`fixture line ${index + 1}: ${why}`);
  };

  // Queries: one response each, after it.
  const queries = new Map<string, { index: number; line: Rec }>();
  const answered = new Set<string>();
  lines.forEach((l, i) => {
    const r = l.line;
    if (!isRec(r)) return;
    if (l.dir === "in" && typeof r.type === "string" && r.type.startsWith("get_")) {
      if (typeof r.id !== "string" || queries.has(r.id)) fail(i, "query without a unique id");
      queries.set(r.id as string, { index: i, line: r });
    }
    if (l.dir === "out" && r.type === "response" && typeof r.id === "string" && queries.has(r.id)) {
      const query = queries.get(r.id);
      if (answered.has(r.id)) fail(i, `second response to ${r.id}`);
      if (query?.line.type !== r.command) fail(i, `response to ${r.id} names ${String(r.command)}`);
      answered.add(r.id);
    }
  });
  for (const [id, { index }] of queries) {
    if (!answered.has(id)) fail(index, `query ${id} has no response`);
  }

  // Entry chain, rebuilt from the get_entries responses in order. After the first gating command
  // a message entry follows its message_end (before it, as in a resumed session, there are none).
  let chain: Rec[] = [];
  const messageEnds = new Set<string>();
  let gated = false;
  let pendingSync = -1;
  let lastWasFull = false;
  lines.forEach((l, i) => {
    const r = l.line;
    if (!isRec(r)) return;
    if (l.dir === "in" && typeof r.type === "string" && !r.type.startsWith("get_")) gated = true;
    if (l.dir === "in" && r.type === "get_entries") pendingSync = -1;
    if (l.dir === "out" && r.type === "message_end" && isRec(r.message)) {
      const key = keyOf(r.message);
      if (messageEnds.has(key)) fail(i, `duplicate role:timestamp ${key}`);
      if (pendingSync >= 0) fail(pendingSync, "message_end not followed by get_entries");
      messageEnds.add(key);
      pendingSync = i;
    }
    if (l.dir !== "out" || r.type !== "response" || r.command !== "get_entries") return;
    const since = queries.get(r.id as string)?.line.since;
    const data = r.data as { entries: Rec[]; leafId: string | null };
    lastWasFull = since === undefined;
    if (since === undefined) {
      if (!chain.every((e, j) => data.entries[j]?.id === e.id))
        fail(i, "full get_entries drops entries");
      chain = [];
    } else if (!chain.some((e) => e.id === since)) {
      fail(i, `get_entries since unknown ${String(since)}`);
    }
    for (const entry of data.entries) {
      if (chain.some((e) => e.id === entry.id)) continue;
      if (entry.parentId !== (chain.at(-1)?.id ?? null)) {
        fail(i, `entry ${String(entry.id)} breaks the parentId chain`);
      }
      if (gated && entry.type === "message" && isRec(entry.message)) {
        if (!messageEnds.has(keyOf(entry.message)))
          fail(i, `entry ${String(entry.id)} precedes its message_end`);
      }
      chain.push(entry);
    }
    if (data.leafId !== (chain.at(-1)?.id ?? null)) fail(i, "leafId is not the last entry");
  });
  if (pendingSync >= 0) fail(pendingSync, "message_end not followed by get_entries");
  if (!lastWasFull) throw new Error("the fixture doesn't end with a full get_entries");
  const committed = new Set(
    chain
      .filter((e) => e.type === "message" && isRec(e.message))
      .map((e) => keyOf(e.message as Rec)),
  );
  for (const key of messageEnds) {
    if (!committed.has(key)) throw new Error(`message ${key} never reaches the entries`);
  }

  // Streamed content: deltas add up to the final message; tool calls run and get results.
  let deltas = new Map<string, string>();
  const calls = new Set<string>();
  const started = new Set<string>();
  const ended = new Set<string>();
  const results = new Set<string>();
  lines.forEach((l, i) => {
    const r = l.line;
    if (l.dir !== "out" || !isRec(r)) return;
    if (r.type === "message_start") deltas = new Map();
    if (r.type === "message_update" && isRec(r.assistantMessageEvent)) {
      const e = r.assistantMessageEvent;
      const kind = String(e.type).replace(/_delta$/, "");
      if (e.type === "text_delta" || e.type === "thinking_delta") {
        const k = `${kind}:${String(e.contentIndex)}`;
        deltas.set(k, (deltas.get(k) ?? "") + String(e.delta));
      }
      if (e.type === "toolcall_end" && isRec(e.toolCall)) calls.add(String(e.toolCall.id));
    }
    if (r.type === "message_end" && isRec(r.message) && r.message.role === "assistant") {
      (r.message.content as Rec[]).forEach((c, index) => {
        const streamed = (kind: string) => deltas.get(`${kind}:${index}`) ?? "";
        if (c.type === "text" && streamed("text") !== c.text)
          fail(i, `text ${index} differs from its deltas`);
        if (c.type === "thinking" && streamed("thinking") !== c.thinking) {
          fail(i, `thinking ${index} differs from its deltas`);
        }
        if (c.type === "toolCall" && !calls.has(String(c.id)))
          fail(i, `tool call ${String(c.id)} never streamed`);
      });
    }
    if (r.type === "tool_execution_start") started.add(String(r.toolCallId));
    if (r.type === "tool_execution_end") ended.add(String(r.toolCallId));
    if (r.type === "message_end" && isRec(r.message) && r.message.role === "toolResult") {
      results.add(String(r.message.toolCallId));
    }
  });
  for (const id of calls) {
    if (!started.has(id) || !ended.has(id) || !results.has(id)) {
      throw new Error(`tool call ${id} doesn't run to a result`);
    }
  }

  // Trailing queries report the expected session.
  for (const command of ["get_state", "get_session_stats"]) {
    const response = lines.findLast(
      (l) =>
        l.dir === "out" &&
        isRec(l.line) &&
        l.line.type === "response" &&
        l.line.command === command,
    );
    const data = response && isRec(response.line) ? (response.line.data as Rec) : undefined;
    if (data?.sessionFile !== expected.sessionFile) {
      throw new Error(`${command} doesn't report ${expected.sessionFile}`);
    }
  }
}
