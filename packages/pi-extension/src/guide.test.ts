import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import guideExtension, { GUIDE_TOOL, guideSchema } from "./guide.ts";

/** Loads the extension into a fake `pi` that captures registrations. */
function load() {
  const tools = new Map<string, ToolDefinition>();
  const other: string[] = [];
  const pi = new Proxy(
    {
      registerTool: (tool: ToolDefinition) => {
        tools.set(tool.name, tool);
      },
    },
    {
      get: (target, key) => {
        if (key in target) return target[key as keyof typeof target];
        return () => other.push(String(key));
      },
    },
  ) as unknown as ExtensionAPI;
  guideExtension(pi);
  return { tools, other };
}

describe("guide extension", () => {
  it("registers submit_guide only", () => {
    const { tools, other } = load();
    expect([...tools.keys()]).toEqual([GUIDE_TOOL]);
    expect(GUIDE_TOOL).toBe("submit_guide");
    expect(other).toEqual([]);
  });

  it("accepts sections of titled, explained hunks", () => {
    const args = {
      sections: [
        { title: "Core", explanation: "Why **this**.", hunks: ["a.ts#1", "b.ts#2"] },
        { title: "Glue", explanation: "", hunks: ["a.ts#1"] },
      ],
    };
    expect(Value.Check(guideSchema, args)).toBe(true);
  });

  it.each([
    ["no sections", { sections: [] }],
    ["a section without hunks", { sections: [{ title: "t", explanation: "e", hunks: [] }] }],
    ["a missing explanation", { sections: [{ title: "t", hunks: ["a#1"] }] }],
    ["a non-string hunk id", { sections: [{ title: "t", explanation: "e", hunks: [1] }] }],
    ["no object", "sections"],
  ])("rejects %s", (_name, args) => {
    expect(Value.Check(guideSchema, args)).toBe(false);
  });

  it("confirms the submission, returns the validated arguments and ends the run", async () => {
    const tool = load().tools.get(GUIDE_TOOL);
    if (!tool) throw new Error("submit_guide not registered");
    const args = { sections: [{ title: "Core", explanation: "Why.", hunks: ["a.ts#1"] }] };
    const result = await tool.execute(
      "call-1",
      args,
      undefined,
      undefined,
      {} as Parameters<ToolDefinition["execute"]>[4],
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "Guide submitted." }],
      details: args,
      terminate: true,
    });
  });
});
