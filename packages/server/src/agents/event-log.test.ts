import { describe, expect, it } from "vitest";
import { EventLog } from "./event-log.ts";

const ev = (id: string) => ({ type: "ui_resolved" as const, id });

describe("EventLog", () => {
  it("assigns seqs, keeps the last `capacity` events, and replays from a seq", () => {
    const log = new EventLog(3);
    expect(log.since(0)).toEqual([]);
    for (const id of ["a", "b", "c", "d", "e"]) log.append(ev(id));
    expect(log.seq).toBe(5);
    expect(log.since(2)?.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(log.since(4)?.map((e) => e.event)).toEqual([ev("e")]);
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
});
