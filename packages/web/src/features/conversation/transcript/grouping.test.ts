import type { SessionEntry } from "@pi-code/protocol";
import { describe, expect, it } from "vitest";
import type { Step } from "@/store/turns";
import { failedToolCalls, foldSteps, groupCountLabel, groupSteps, type Item } from "./grouping";

const tool = (id: string, toolName: string): Step => ({
  kind: "tool",
  key: id,
  toolCallId: id,
  toolName,
  args: {},
});
const thinking = (key: string): Step => ({ kind: "thinking", key, text: "hmm", redacted: false });
const text = (key: string, t = "some text"): Step => ({ kind: "text", key, text: t });
const entry = (key: string): Step => ({
  kind: "entry",
  key,
  entryId: key,
  entry: { type: "model_change", id: key } as unknown as SessionEntry,
});
const stop = (key: string): Step => ({
  kind: "stop",
  key,
  entryId: key,
  message: { role: "assistant", stopReason: "aborted" } as never,
});

/** Items as keys: a group as `[child keys]`. */
const shape = (items: Item[]) =>
  items.map((item) => (item.kind === "group" ? item.steps.map((s) => s.key) : item.key));

describe("groupSteps", () => {
  it("groups consecutive exploration calls, keyed by the first", () => {
    const items = groupSteps([tool("r1", "read"), tool("g1", "grep"), tool("f1", "find")]);
    expect(shape(items)).toEqual([["r1", "g1", "f1"]]);
    expect(items[0]).toMatchObject({ kind: "group", key: "r1" });
  });

  it("groups every exploration tool", () => {
    const names = [
      "read",
      "grep",
      "find",
      "ls",
      "web_search",
      "fetch_content",
      "source_check",
      "get_search_content",
    ];
    const items = groupSteps(names.map((name, i) => tool(`t${i}`, name)));
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === "group" && items[0].steps).toHaveLength(names.length);
  });

  it("absorbs thinking between two calls; leading and trailing thinking stay out", () => {
    const items = groupSteps([
      thinking("k0"),
      tool("r1", "read"),
      thinking("k1"),
      thinking("k2"),
      tool("r2", "read"),
      thinking("k3"),
    ]);
    expect(shape(items)).toEqual(["k0", ["r1", "k1", "k2", "r2"], "k3"]);
  });

  it("leaves a lone call ungrouped, with the thinking after it", () => {
    expect(shape(groupSteps([tool("r1", "read"), thinking("k1"), text("x")]))).toEqual([
      "r1",
      "k1",
      "x",
    ]);
  });

  it.each([
    ["text", text("x")],
    ["edit", tool("x", "edit")],
    ["write", tool("x", "write")],
    ["bash", tool("x", "bash")],
    ["spawn", tool("x", "spawn")],
    ["mcp", tool("x", "mcp")],
    ["an unknown tool", tool("x", "mystery")],
    ["an entry", entry("x")],
    ["a stop notice", stop("x")],
  ])("breaks on %s", (_, step) => {
    const items = groupSteps([
      tool("r1", "read"),
      tool("r2", "read"),
      thinking("k1"),
      step,
      tool("r3", "read"),
      tool("r4", "read"),
    ]);
    expect(shape(items)).toEqual([["r1", "r2"], "k1", "x", ["r3", "r4"]]);
  });

  it("breaks a failed call out as its own row", () => {
    const items = groupSteps(
      [tool("r1", "read"), tool("r2", "read"), tool("r3", "read"), tool("r4", "read")],
      new Set(["r3"]),
    );
    expect(shape(items)).toEqual([["r1", "r2"], "r3", "r4"]);
  });

  it("ignores blank text", () => {
    const items = groupSteps([tool("r1", "read"), text("blank", "  \n"), tool("r2", "read")]);
    expect(shape(items)).toEqual([["r1", "r2"]]);
  });
});

describe("groupCountLabel", () => {
  it("counts per kind, in order, with plurals, leaving zero counts out", () => {
    expect(
      groupCountLabel([
        tool("a", "web_search"),
        tool("b", "read"),
        tool("c", "grep"),
        tool("d", "read"),
        tool("e", "find"),
        tool("f", "read"),
        tool("g", "source_check"),
        tool("h", "fetch_content"),
        thinking("k"),
      ]),
    ).toBe("3 files, 2 searches, 2 web searches, 1 page");
    expect(groupCountLabel([tool("a", "read"), tool("b", "ls"), tool("c", "ls")])).toBe(
      "1 file, 2 listings",
    );
    expect(
      groupCountLabel([
        tool("a", "grep"),
        tool("b", "web_search"),
        tool("c", "get_search_content"),
        tool("d", "fetch_content"),
      ]),
    ).toBe("1 search, 1 web search, 2 pages");
  });
});

describe("foldSteps", () => {
  it("folds the work and non-final text; keeps the final text and other steps", () => {
    const { folded, rest } = foldSteps([
      entry("e0"),
      thinking("k1"),
      text("t1"),
      tool("r1", "read"),
      text("t2"),
      text("t3"),
      stop("s1"),
    ]);
    expect(folded.map((s) => s.key)).toEqual(["k1", "t1", "r1"]);
    expect(rest.map((s) => s.key)).toEqual(["e0", "t2", "t3", "s1"]);
  });

  it("folds nothing without thinking or tools", () => {
    expect(foldSteps([text("t1"), text("t2")]).folded).toEqual([]);
  });
});

describe("failedToolCalls", () => {
  it("collects calls whose committed result is an error", () => {
    const result = (id: string, isError: boolean) =>
      ({
        type: "message",
        id: `m-${id}`,
        message: { role: "toolResult", toolCallId: id, isError },
      }) as unknown as SessionEntry;
    expect(failedToolCalls([result("a", false), result("b", true)])).toEqual(new Set(["b"]));
  });
});
