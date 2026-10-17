import type { AgentId, CursorList, StreamFrame } from "@pi-code/protocol";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentManager } from "../agents/agent-manager.ts";
import type { EventLog, LoggedEvent } from "../agents/event-log.ts";
import type { StreamHub } from "../live/stream-hub.ts";

export interface SseOptions {
  /**
   * Interval of `ping` events (named, no `id:`), so clients can detect a dead stream.
   * Default 15 s.
   */
  pingMs?: number;
  /** Reconnection delay advertised to `EventSource`. Default 2 s. */
  retryMs?: number;
  /**
   * A connection with this many live frames queued is ended: its socket is stalled, and the
   * client reconnects and replays or resyncs. On a stalled socket the stop is observed once the
   * pending write settles; the queue stays bounded meanwhile.
   */
  maxBacklog?: number;
}

/**
 * Parses a `CursorList` (`open` query, `Last-Event-ID`). Pairs without `:` or without an id are
 * dropped; a seq that isn't a non-negative integer is kept as `NaN`, which no log can replay.
 */
function parseCursors(value: string | undefined): Map<AgentId, number> {
  const cursors = new Map<AgentId, number>();
  for (const pair of value?.split(",") ?? []) {
    const colon = pair.indexOf(":");
    const id = pair.slice(0, colon).trim();
    if (colon < 0 || id === "") continue;
    const seq = pair.slice(colon + 1).trim();
    cursors.set(id, /^\d+$/.test(seq) ? Number(seq) : Number.NaN);
  }
  return cursors;
}

/**
 * The `data:` of an agent's `event` frame: `JSON.stringify` of `{ type, agentId, seq, event }`,
 * built around the event's JSON from the log, so each event is serialised once however many
 * connections stream it.
 */
export function eventFrameData(agentId: AgentId, { seq, json }: LoggedEvent): string {
  return `{"type":"event","agentId":${JSON.stringify(agentId)},"seq":${seq},"event":${json}}`;
}

/**
 * `GET /api/stream?open=<id>:<seq>,…`: the baseline, then every agent's info changes, plus the
 * events of each opened agent from its cursor (a `Last-Event-ID` cursor wins over the query's),
 * or `resync` when its log can't replay from there.
 *
 * Each connection writes `retry:`, the baseline, then each opened agent's replay (or `resync`)
 * as its own write, then drains a queue of live frames to the socket, with a named `ping` every
 * `pingMs`. Live frames arriving meanwhile wait in the queue; the replay doesn't count against
 * `maxBacklog`.
 */
export function streamRoutes(manager: AgentManager, hub: StreamHub, opts: SseOptions = {}) {
  const pingMs = opts.pingMs ?? 15_000;
  const retryMs = opts.retryMs ?? 2_000;
  const maxBacklog = opts.maxBacklog ?? 20_000;

  return new Hono().get("/", async (c) => {
    const opened = parseCursors(c.req.query("open"));
    const resumed = parseCursors(c.req.header("last-event-id"));
    await hub.ready;
    return streamSSE(c, async (stream) => {
      const pending: string[] = [];
      let wake: (() => void) | undefined;
      let stop = false; // client gone, or too far behind: end now
      let pingDue = false;
      const notify = () => {
        const w = wake;
        wake = undefined;
        w?.();
      };
      const send = (frame: string) => {
        if (pending.length >= maxBacklog) stop = true;
        else pending.push(frame);
        notify();
      };

      // Replay and subscription happen in one synchronous block: publishing is synchronous
      // too, so no event can fall between them.
      const streamed: { id: AgentId; log: EventLog; replay: LoggedEvent[] | undefined }[] = [];
      // Each streamed agent's position, listed in `open` order. A resyncing agent has none until
      // its `resync` is queued, a closed one none from then on.
      const cursors = new Map<AgentId, number>();
      for (const [id, querySeq] of opened) {
        const agent = manager.get(id);
        if (agent === undefined) continue;
        const log = agent.pipeline.log;
        const seq = resumed.get(id) ?? querySeq;
        const replay = log.since(seq);
        streamed.push({ id, log, replay });
        if (replay !== undefined) cursors.set(id, seq);
      }
      const sseFrame = (data: string) => {
        const ids: CursorList = streamed
          .flatMap(({ id }) => (cursors.has(id) ? [`${id}:${cursors.get(id)}`] : []))
          .join(",");
        return `id: ${ids}\ndata: ${data}\n\n`;
      };
      const frame = (f: StreamFrame) => sseFrame(JSON.stringify(f));
      const eventFrame = (agentId: AgentId, logged: LoggedEvent) => {
        cursors.set(agentId, logged.seq);
        return sseFrame(eventFrameData(agentId, logged));
      };

      // Written in order before the queue, one write each.
      const initial = [`retry: ${retryMs}\n\n`, frame(hub.baseline())];
      const logSubscriptions = new Map<AgentId, () => void>();
      for (const entry of streamed) {
        const { id, log, replay } = entry;
        // `streamed` lives as long as the connection (`frame` reads it); only the chunk built
        // below keeps the replay, until it's written.
        entry.replay = undefined;
        if (replay === undefined) {
          cursors.set(id, log.seq);
          initial.push(frame({ type: "resync", agentId: id }));
        } else if (replay.length > 0) {
          initial.push(replay.map((sequenced) => eventFrame(id, sequenced)).join(""));
        }
        // When the log closes (`agent_closed` tells the client), the agent leaves the connection:
        // its subscription is dropped and its cursor leaves later `id:` lists.
        const unsubscribe = log.subscribe(
          (sequenced) => send(eventFrame(id, sequenced)),
          () => {
            unsubscribe();
            logSubscriptions.delete(id);
            cursors.delete(id);
          },
        );
        logSubscriptions.set(id, unsubscribe);
      }
      const unsubscribeHub = hub.subscribe((f) => send(frame(f)));

      const abort = () => {
        stop = true;
        notify();
      };
      stream.onAbort(abort);
      c.req.raw.signal.addEventListener("abort", abort, { once: true });
      const ping = setInterval(() => {
        pingDue = true;
        notify();
      }, pingMs);

      try {
        // `shift` drops each written chunk, so a long replay isn't held until the end.
        for (let chunk = initial.shift(); chunk !== undefined; chunk = initial.shift()) {
          if (stop || stream.aborted) break;
          await stream.write(chunk);
        }
        while (!stop && !stream.aborted) {
          if (pending.length > 0) {
            await stream.write(pending.splice(0, pending.length).join(""));
          } else if (pingDue) {
            pingDue = false;
            await stream.write("event: ping\ndata: {}\n\n");
          } else {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
      } finally {
        clearInterval(ping);
        for (const unsubscribe of logSubscriptions.values()) unsubscribe();
        unsubscribeHub();
      }
    });
  });
}
