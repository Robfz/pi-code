import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SidebarState } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { parseSidebarPatch, SIDEBAR_FILE, SidebarStateStore } from "./sidebar-state.ts";

let root: string;
let data: string;
let a: string;
let b: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-sidebar-")));
  data = join(root, "data");
  a = join(root, "a");
  b = join(root, "b");
  mkdirSync(a);
  mkdirSync(b);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const saved = (): unknown => JSON.parse(readFileSync(join(data, SIDEBAR_FILE), "utf8"));

describe("SidebarStateStore", () => {
  it("starts empty without a file and sets flags idempotently", async () => {
    const store = new SidebarStateStore(data);
    await store.ready;
    expect(store.current()).toEqual({ pinned: [], collapsed: [] });
    const changes: SidebarState[] = [];
    store.subscribe((state) => changes.push(state));

    await store.update({ pinned: { [a]: true }, collapsed: { [a]: true, [b]: true } });
    await store.update({ pinned: { [a]: true }, collapsed: { [b]: true } });
    expect(store.current()).toEqual({ pinned: [a], collapsed: [a, b] });
    await store.update({ collapsed: { [a]: false, [join(root, "never")]: false } });
    expect(store.current()).toEqual({ pinned: [a], collapsed: [b] });
    // Only actual changes are announced.
    expect(changes).toEqual([
      { pinned: [a], collapsed: [a, b] },
      { pinned: [a], collapsed: [b] },
    ]);
    expect(saved()).toEqual({ pinned: [a], collapsed: [b] });
    const reloaded = new SidebarStateStore(data);
    await reloaded.ready;
    expect(reloaded.current()).toEqual(store.current());
  });

  it("applies updates in arrival order", async () => {
    const store = new SidebarStateStore(data);
    const first = store.update({ collapsed: { [a]: true } });
    const second = store.update({ collapsed: { [a]: false } });
    await Promise.all([first, second]);
    expect(store.current().collapsed).toEqual([]);
  });

  it("doesn't add a path whose directory doesn't exist", async () => {
    const store = new SidebarStateStore(data);
    writeFileSync(join(root, "file"), "");
    const state = await store.update({
      pinned: { [join(root, "gone")]: true },
      collapsed: { [join(root, "file")]: true },
    });
    expect(state).toEqual({ pinned: [], collapsed: [] });
  });

  it("prunes entries whose directory is gone, on load and on prune", async () => {
    mkdirSync(data);
    writeFileSync(
      join(data, SIDEBAR_FILE),
      JSON.stringify({ pinned: [a, join(root, "gone"), "relative", 3], collapsed: [b, a, b] }),
    );
    const store = new SidebarStateStore(data);
    await store.ready;
    expect(store.current()).toEqual({ pinned: [a], collapsed: [b, a] });
    expect(saved()).toEqual({ pinned: [a], collapsed: [b, a] });

    const changes: SidebarState[] = [];
    store.subscribe((state) => changes.push(state));
    rmSync(a, { recursive: true });
    await store.prune();
    await store.prune();
    expect(changes).toEqual([{ pinned: [], collapsed: [b] }]);
  });

  it("keeps its state when the file can't be written", async () => {
    const store = new SidebarStateStore(data);
    await store.update({ pinned: { [a]: true } });
    const changes: SidebarState[] = [];
    store.subscribe((state) => changes.push(state));
    // A non-empty directory in the file's place makes the rename fail.
    rmSync(join(data, SIDEBAR_FILE));
    mkdirSync(join(data, SIDEBAR_FILE, "obstacle"), { recursive: true });

    await expect(store.update({ collapsed: { [b]: true } })).rejects.toThrow();
    expect(store.current()).toEqual({ pinned: [a], collapsed: [] });
    expect(changes).toEqual([]);

    rmSync(join(data, SIDEBAR_FILE), { recursive: true });
    await store.update({ collapsed: { [b]: true } });
    expect(store.current()).toEqual({ pinned: [a], collapsed: [b] });
    expect(changes).toEqual([{ pinned: [a], collapsed: [b] }]);
    expect(saved()).toEqual({ pinned: [a], collapsed: [b] });
  });

  it("ignores an unreadable file", async () => {
    mkdirSync(data);
    writeFileSync(join(data, SIDEBAR_FILE), "{not json");
    const store = new SidebarStateStore(data);
    await store.ready;
    expect(store.current()).toEqual({ pinned: [], collapsed: [] });
  });
});

describe("parseSidebarPatch", () => {
  it("accepts path → boolean records", () => {
    expect(parseSidebarPatch({ pinned: { "/a": true }, collapsed: { "/b": false } })).toEqual({
      pinned: { "/a": true },
      collapsed: { "/b": false },
    });
    expect(parseSidebarPatch({})).toEqual({});
  });

  it.each([
    null,
    [],
    { pinned: [] },
    { pinned: { "/a": "yes" } },
    { collapsed: { "rel/path": true } },
    { other: {} },
  ])("rejects %j", (body) => {
    expect(() => parseSidebarPatch(body)).toThrow(ApiError);
  });
});
