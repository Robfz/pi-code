import type { AgentId, CursorList, SequencedEvent, StreamFrame } from "@pi-code/protocol";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentManager } from "../agents/agent-manager.ts";
import type { EventLog } from "../agents/event-log.ts";
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

/** Where a connection sends frames. */
interface SseSink {
  /** Queues a live frame (or ends the connection when `maxBacklog` frames are queued). */
  send(frame: string): void;
  /** Ends the connection once the queued frames are written. */
  end(): void;
}

interface SseSubscription {
  /** Frames written right after `retry:`, not counted against `maxBacklog`. */
  initial: string[];
  unsubscribe(): void;
}

/**
 * An SSE response fed through a per-connection frame queue drained to the socket, with
 * `retry:` first and a named `ping` every `pingMs`. `subscribe` runs synchronously before
 * anything is written; `unsubscribe` runs when the connection ends.
 */
export function queuedSse(
  c: Context,
  opts: SseOptions,
  subscribe: (sink: SseSink) => SseSubscription,
): Response {
  const pingMs = opts.pingMs ?? 15_000;
  const retryMs = opts.retryMs ?? 2_000;
  const maxBacklog = opts.maxBacklog ?? 20_000;

  return streamSSE(c, async (stream) => {
    const pending: string[] = [];
    let wake: (() => void) | undefined;
    let stop = false; // client gone, or too far behind: end now
    let ending = false; // source gone: flush, then end
    let pingDue = false;
    const notify = () => {
      const w = wake;
      wake = undefined;
      w?.();
    };
    const { initial, unsubscribe } = subscribe({
      send(frame) {
        if (pending.length >= maxBacklog) stop = true;
        else pending.push(frame);
        notify();
      },
      end() {
        ending = true;
        notify();
      },
    });
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
      await stream.write(`retry: ${retryMs}\n\n${initial.join("")}`);
      while (!stop && !stream.aborted) {
        if (pending.length > 0) {
          await stream.write(pending.splice(0, pending.length).join(""));
        } else if (ending) {
          break;
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
      unsubscribe();
    }
  });
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
 * `GET /api/stream?open=<id>:<seq>,…`: the baseline, then every agent's info changes, plus the
 * events of each opened agent from its cursor (a `Last-Event-ID` cursor wins over the query's),
 * or `resync` when its log can't replay from there.
 */
export function streamRoutes(manager: AgentManager, hub: StreamHub, opts: SseOptions = {}) {
  return new Hono().get("/", async (c) => {
    const opened = parseCursors(c.req.query("open"));
    const resumed = parseCursors(c.req.header("last-event-id"));
    await hub.ready;
    return queuedSse(c, opts, (sink) => {
      // Replay and subscription happen in one synchronous block: publishing is synchronous
      // too, so no event can fall between them.
      const streamed: { id: AgentId; log: EventLog; replay: SequencedEvent[] | undefined }[] = [];
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
      const frame = (f: StreamFrame) => {
        const ids: CursorList = streamed
          .flatMap(({ id }) => (cursors.has(id) ? [`${id}:${cursors.get(id)}`] : []))
          .join(",");
        return `id: ${ids}\ndata: ${JSON.stringify(f)}\n\n`;
      };
      const eventFrame = (agentId: AgentId, { seq, event }: SequencedEvent) => {
        cursors.set(agentId, seq);
        return frame({ type: "event", agentId, seq, event });
      };

      const initial = [frame(hub.baseline())];
      const logSubscriptions = new Map<AgentId, () => void>();
      for (const { id, log, replay } of streamed) {
        if (replay === undefined) {
          cursors.set(id, log.seq);
          initial.push(frame({ type: "resync", agentId: id }));
        } else {
          for (const sequenced of replay) initial.push(eventFrame(id, sequenced));
        }
        // When the log closes (`agent_closed` tells the client), the agent leaves the connection:
        // its subscription is dropped and its cursor leaves later `id:` lists.
        const unsubscribe = log.subscribe(
          (sequenced) => sink.send(eventFrame(id, sequenced)),
          () => {
            unsubscribe();
            logSubscriptions.delete(id);
            cursors.delete(id);
          },
        );
        logSubscriptions.set(id, unsubscribe);
      }
      const unsubscribeHub = hub.subscribe((f) => sink.send(frame(f)));
      return {
        initial,
        unsubscribe: () => {
          for (const unsubscribe of logSubscriptions.values()) unsubscribe();
          unsubscribeHub();
        },
      };
    });
  });
}
