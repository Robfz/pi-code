import { describe, expect, it } from "vitest";
import { EventLog, type LoggedEvent } from "./event-log.ts";

const ev = (id: string) => ({ type: "ui_resolved" as const, id });
const events = (logged: LoggedEvent[] | undefined) => logged?.map((e) => JSON.parse(e.json));

describe("EventLog", () => {
  it("assigns seqs, keeps the last `capacity` events, and replays from a seq", () => {
    const log = new EventLog(3);
    expect(log.since(0)).toEqual([]);
    for (const id of ["a", "b", "c", "d", "e"]) log.append(ev(id));
    expect(log.seq).toBe(5);
    expect(log.since(2)?.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(events(log.since(4))).toEqual([ev("e")]);
    expect(log.since(5)).toEqual([]);
    expect(log.since(1)).toBeUndefined(); // seq 2 was dropped
    expect(log.since(6)).toBeUndefined(); // ahead of the log
    expect(log.since(-1)).toBeUndefined();
    expect(log.since(Number.NaN)).toBeUndefined();
    for (let i = 0; i < 20; i++) log.append(ev(String(i)));
    expect(log.since(log.seq - 3)?.map((e) => e.seq)).toEqual([23, 24, 25]);
  });

  it("fans out synchronously, survives failing listeners, and closes", () => {
    const log = new EventLog();
    const seen: number[] = [];
    let closed = 0;
    log.subscribe(() => {
      throw new Error("boom");
    });
    const off = log.subscribe(
      (e) => seen.push(e.seq),
      () => closed++,
    );
    log.append(ev("a"));
    expect(seen).toEqual([1]);
    log.close();
    log.close();
    expect(closed).toBe(1);
    off();
    log.append(ev("b"));
    expect(seen).toEqual([1]);
    expect(log.subscriberCount).toBe(1);
  });

  it("evicts the oldest events while their JSON passes maxBytes, resyncing evicted cursors", () => {
    const big = (id: string) => ev(id.padEnd(100, "x"));
    const size = JSON.stringify(big("a")).length;
    const log = new EventLog(100, size * 3);
    for (const id of ["a", "b", "c"]) log.append(big(id));
    expect(log.since(0)?.map((e) => e.seq)).toEqual([1, 2, 3]);

    log.append(big("d"));
    expect(log.since(0)).toBeUndefined(); // seq 1 was evicted
    expect(log.since(1)?.map((e) => e.seq)).toEqual([2, 3, 4]);

    // A small event fits beside the three large ones only once the oldest is gone.
    log.append(ev("e"));
    expect(log.since(1)).toBeUndefined();
    expect(log.since(2)?.map((e) => e.seq)).toEqual([3, 4, 5]);

    // One event larger than the bound leaves nothing to replay: every older cursor resyncs.
    log.append(ev("y".repeat(size * 4)));
    expect(log.since(5)).toBeUndefined();
    expect(log.since(6)).toEqual([]);
    log.append(ev("f"));
    expect(events(log.since(6))).toEqual([ev("f")]);
  });

  it("keeps seqs contiguous across count and byte evictions", () => {
    const log = new EventLog(5, 1_000);
    for (let i = 0; i < 200; i++) log.append(ev("z".repeat((i * 37) % 300)));
    expect(log.since(log.seq - 1)?.map((e) => e.seq)).toEqual([200]);
    for (let since = 0; since <= log.seq; since++) {
      const replay = log.since(since);
      if (replay === undefined) continue;
      expect(replay.map((e) => e.seq)).toEqual(
        Array.from({ length: log.seq - since }, (_, i) => since + 1 + i),
      );
    }
  });

  it("serialises each event once, for subscribers and replays alike", () => {
    const log = new EventLog();
    const seen: string[] = [];
    log.subscribe((e) => seen.push(e.json));
    const event = ev('é😀\n"x"');
    const appended = log.append(event);
    expect(appended).toEqual({ seq: 1, json: JSON.stringify(event) });
    expect(seen).toEqual([appended.json]);
    expect(log.since(0)?.[0]).toBe(appended);
  });
});
