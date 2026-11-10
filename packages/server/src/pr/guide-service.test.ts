import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrGuide } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuideStore } from "../store/guide-store.ts";
import { GUIDE_VERSION } from "./guide-format.ts";
import type { GuideInput } from "./guide-job.ts";
import { GuideService, type GuideState, guideInputKey } from "./guide-service.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

const input: GuideInput = {
  cwd: "/repo",
  folder: "",
  pr: { repo: "o/r", number: 7, title: "T", body: "" },
  baseSha: BASE,
  headSha: HEAD,
};
const key = guideInputKey(input);

function guideOf(title: string): PrGuide {
  return {
    version: GUIDE_VERSION,
    repo: "o/r",
    number: 7,
    baseSha: BASE,
    headSha: HEAD,
    sections: [{ title, explanation: "", hunks: ["a#1"] }],
    other: [],
  };
}

/** A runner whose jobs the test settles; each job records whether it was aborted. */
function fakeRunner() {
  const jobs: {
    input: GuideInput;
    signal: AbortSignal;
    resolve: (guide: PrGuide) => void;
    reject: (e: Error) => void;
  }[] = [];
  const run = (jobInput: GuideInput, signal: AbortSignal) =>
    new Promise<PrGuide>((resolve, reject) => {
      jobs.push({ input: jobInput, signal, resolve, reject });
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  return { run, jobs };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!check()) throw new Error("timed out");
}

/** Waits for the runner to have been asked for `n` jobs. */
const started = (n: number) => until(() => runner.jobs.length >= n);

/** The store, with its first read held until `release`. */
function heldStore() {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let reading = false;
  const gated = Object.assign(Object.create(store) as GuideStore, {
    read: async (k: string) => {
      if (!reading) {
        reading = true;
        await held;
      }
      return store.read(k);
    },
  });
  return { store: gated, release, reading: () => reading };
}

let dataDir: string;
let store: GuideStore;
let runner: ReturnType<typeof fakeRunner>;
let service: GuideService;
let events: [string, GuideState][];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "pi-code-guide-service-"));
  store = new GuideStore(dataDir);
  runner = fakeRunner();
  service = new GuideService(store, runner.run);
  events = [];
  service.subscribe((k, state) => {
    events.push([k, state]);
  });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("GuideService", () => {
  it("reads none for a key with nothing stored, running or failed", async () => {
    expect(await service.status(key)).toEqual({ state: "none" });
  });

  it("keys a guide by its PR diff and the folder it's read from", () => {
    expect(key).toBe(`o/r#7@${BASE}..${HEAD}`);
    expect(guideInputKey({ ...input, cwd: "/repo/sub", folder: "sub/" })).toBe(
      `o/r#7@${BASE}..${HEAD}:sub/`,
    );
  });

  it("generates, stores and reports a guide", async () => {
    const done = service.ensure(input);
    await started(1);
    expect(await service.status(key)).toEqual({ state: "generating" });
    expect(runner.jobs.map((j) => j.input)).toEqual([input]);
    const guide = guideOf("Core");
    runner.jobs[0]?.resolve(guide);
    await done;
    expect(await service.status(key)).toEqual({ state: "ready", guide });
    expect(await store.read(key)).toEqual({ state: "ready", guide });
    expect(events).toEqual([
      [key, { state: "generating" }],
      [key, { state: "ready", guide }],
    ]);
  });

  it("starts no job for a stored guide, outdated included", async () => {
    await store.write(key, guideOf("Stored"));
    await service.ensure(input);
    await store.write(key, { ...guideOf("Old"), version: GUIDE_VERSION - 1 });
    await service.ensure(input);
    expect(runner.jobs).toEqual([]);
    expect(events).toEqual([]);
    expect(await service.status(key)).toEqual({
      state: "failed",
      error: "guide format is outdated; retry",
    });
  });

  it("joins a running job", async () => {
    const first = service.ensure(input);
    const second = service.ensure(input);
    await started(1);
    expect(service.ensure(input)).toBe(service.ensure(input));
    expect(runner.jobs).toHaveLength(1);
    runner.jobs[0]?.resolve(guideOf("Core"));
    await Promise.all([first, second]);
    expect(runner.jobs).toHaveLength(1);
  });

  it("reports a failure until the next job", async () => {
    const done = service.ensure(input);
    await started(1);
    runner.jobs[0]?.reject(new Error("the guide job ended without calling submit_guide"));
    await done;
    const failed = { state: "failed", error: "the guide job ended without calling submit_guide" };
    expect(await service.status(key)).toEqual(failed);
    expect(events.at(-1)).toEqual([key, failed]);

    const retry = service.ensure(input);
    await started(2);
    expect(await service.status(key)).toEqual({ state: "generating" });
    runner.jobs[1]?.resolve(guideOf("Core"));
    await retry;
    expect(await service.status(key)).toMatchObject({ state: "ready" });
  });

  it("regenerates over a stored guide", async () => {
    await store.write(key, { ...guideOf("Old"), version: GUIDE_VERSION + 1 });
    const done = service.regenerate(input);
    await started(1);
    expect(await service.status(key)).toEqual({ state: "generating" });
    const guide = guideOf("New");
    runner.jobs[0]?.resolve(guide);
    await done;
    expect(await service.status(key)).toEqual({ state: "ready", guide });
  });

  it("regenerating kills a running job and discards its result", async () => {
    const first = service.ensure(input);
    await started(1);
    const second = service.regenerate(input);
    await started(2);
    expect(runner.jobs[0]?.signal.aborted).toBe(true);
    await first;
    expect(await service.status(key)).toEqual({ state: "generating" });
    const guide = guideOf("Second");
    runner.jobs[1]?.resolve(guide);
    await second;
    expect(await service.status(key)).toEqual({ state: "ready", guide });
    expect(events).toEqual([
      [key, { state: "generating" }],
      [key, { state: "generating" }],
      [key, { state: "ready", guide }],
    ]);
  });

  it("regenerating while ensure reads the store starts one job", async () => {
    const held = heldStore();
    const replacing = new GuideService(held.store, runner.run);
    const seen: GuideState[] = [];
    replacing.subscribe((_k, state) => seen.push(state));
    const first = replacing.ensure(input);
    await until(held.reading);
    const second = replacing.regenerate(input);
    await started(1);
    held.release();
    await first;
    const guide = guideOf("Second");
    runner.jobs[0]?.resolve(guide);
    await second;
    expect(runner.jobs).toHaveLength(1);
    expect(seen).toEqual([{ state: "generating" }, { state: "ready", guide }]);
  });

  it("lets a listener told of generating join the job", async () => {
    let joined: Promise<void> | undefined;
    service.subscribe((_k, state) => {
      if (state.state === "generating") joined ??= service.ensure(input);
    });
    const done = service.regenerate(input);
    await started(1);
    expect(joined).toBe(done);
    runner.jobs[0]?.resolve(guideOf("Core"));
    await done;
  });

  it("cancels a running job, discarding its result", async () => {
    const done = service.ensure(input);
    await started(1);
    service.cancel(key);
    expect(runner.jobs[0]?.signal.aborted).toBe(true);
    await done;
    await until(() => events.length === 2);
    expect(await service.status(key)).toEqual({ state: "none" });
    expect(await store.read(key)).toBeUndefined();
    expect(events).toEqual([
      [key, { state: "generating" }],
      [key, { state: "none" }],
    ]);
    service.cancel(key);
  });

  it("cancels a job still reading the store: none starts", async () => {
    const held = heldStore();
    const cancelling = new GuideService(held.store, runner.run);
    const seen: GuideState[] = [];
    cancelling.subscribe((_k, state) => seen.push(state));
    const done = cancelling.ensure(input);
    await until(held.reading);
    cancelling.cancel(key);
    held.release();
    await done;
    expect(runner.jobs).toEqual([]);
    expect(seen).toEqual([]);
    expect(await cancelling.status(key)).toEqual({ state: "none" });
  });

  it("reads generating while a job checks the store, none once it's cancelled", async () => {
    const held = heldStore();
    const checking = new GuideService(held.store, runner.run);
    const done = checking.ensure(input);
    await until(held.reading);
    expect(await checking.status(key)).toEqual({ state: "generating" });
    checking.cancel(key);
    expect(await checking.status(key)).toEqual({ state: "none" });
    held.release();
    await done;
  });

  it("lets a job storing its guide finish when cancelled, and joins it", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let writing = false;
    const slow = new GuideService(
      Object.assign(Object.create(store) as GuideStore, {
        write: async (k: string, g: PrGuide) => {
          writing = true;
          await held;
          return store.write(k, g);
        },
      }),
      runner.run,
    );
    const seen: GuideState[] = [];
    slow.subscribe((_k, state) => seen.push(state));
    const done = slow.ensure(input);
    await started(1);
    const guide = guideOf("Core");
    runner.jobs[0]?.resolve(guide);
    await until(() => writing);
    slow.cancel(key);
    expect(runner.jobs[0]?.signal.aborted).toBe(false);
    expect(slow.ensure(input)).toBe(done);
    release();
    await done;
    expect(runner.jobs).toHaveLength(1);
    expect(seen).toEqual([{ state: "generating" }, { state: "ready", guide }]);
    expect(await slow.status(key)).toEqual({ state: "ready", guide });
  });

  it("discards a result arriving after a cancel", async () => {
    let finish: ((guide: PrGuide) => void) | undefined;
    const ignoring = new GuideService(
      store,
      () => new Promise<PrGuide>((resolve) => (finish = resolve)),
    );
    const done = ignoring.ensure(input);
    await until(() => finish !== undefined);
    ignoring.cancel(key);
    finish?.(guideOf("Late"));
    await done;
    expect(await store.read(key)).toBeUndefined();
    expect(await ignoring.status(key)).toEqual({ state: "none" });
  });

  it("reports a failed store write as a failure", async () => {
    const failing = new GuideService(
      Object.assign(Object.create(store) as GuideStore, {
        write: () => Promise.reject(new Error("disk full")),
      }),
      runner.run,
    );
    const done = failing.ensure(input);
    await started(1);
    runner.jobs[0]?.resolve(guideOf("Core"));
    await done;
    expect(await failing.status(key)).toEqual({ state: "failed", error: "disk full" });
  });

  it("stops telling a listener once it unsubscribes", async () => {
    const seen: GuideState[] = [];
    const unsubscribe = service.subscribe((_k, state) => seen.push(state));
    const done = service.ensure(input);
    await started(1);
    unsubscribe();
    runner.jobs[0]?.resolve(guideOf("Core"));
    await done;
    expect(seen).toEqual([{ state: "generating" }]);
    expect(events.map(([, s]) => s.state)).toEqual(["generating", "ready"]);
  });

  it("keeps going when a listener throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    service.subscribe(() => {
      throw new Error("boom");
    });
    const done = service.ensure(input);
    await started(1);
    runner.jobs[0]?.resolve(guideOf("Core"));
    await done;
    expect(events.map(([, s]) => s.state)).toEqual(["generating", "ready"]);
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});
