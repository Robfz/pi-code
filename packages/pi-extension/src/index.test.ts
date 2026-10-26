import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ProjectTrustHandler,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piCodeExtension, { REFERENCE_GUIDELINE } from "./index.ts";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

/** Loads the extension into a fake `pi` that captures handlers and commands. */
function load() {
  const handlers = new Map<string, unknown>();
  const commands = new Map<string, CommandOptions>();
  const pi = {
    on: (event: string, handler: unknown) => {
      handlers.set(event, handler);
      return () => {};
    },
    registerCommand: (name: string, options: CommandOptions) => {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;
  piCodeExtension(pi);
  return { handlers, commands };
}

function runTrust() {
  const handler = load().handlers.get("project_trust") as ProjectTrustHandler;
  const ui = {} as Parameters<ProjectTrustHandler>[1]["ui"];
  return handler(
    { type: "project_trust", cwd: "/p" },
    { cwd: "/p", mode: "rpc", hasUI: false, ui },
  );
}

describe("project_trust", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("remembers yes", async () => {
    vi.stubEnv("PI_CODE_TRUST", "yes");
    expect(await runTrust()).toEqual({ trusted: "yes", remember: true });
  });

  it("remembers no", async () => {
    vi.stubEnv("PI_CODE_TRUST", "no");
    expect(await runTrust()).toEqual({ trusted: "no", remember: true });
  });

  it("is undecided when unset or unrecognized", async () => {
    vi.stubEnv("PI_CODE_TRUST", undefined);
    expect(await runTrust()).toEqual({ trusted: "undecided" });
    vi.stubEnv("PI_CODE_TRUST", "maybe");
    expect(await runTrust()).toEqual({ trusted: "undecided" });
  });
});

describe("before_agent_start", () => {
  function event(options: Partial<BeforeAgentStartEvent["systemPromptOptions"]>) {
    return {
      type: "before_agent_start",
      messageType: "user",
      prompt: "hi",
      systemPrompt: "",
      systemPromptOptions: {
        cwd: "/p",
        selectedTools: [],
        hiddenTools: [],
        toolSnippets: {},
        toolGuidelines: {},
        promptGuidelines: [],
        appendSystemPrompt: "",
        sections: {},
        contextFiles: [],
        skills: [],
        ...options,
      },
    } satisfies BeforeAgentStartEvent;
  }

  function run(e: BeforeAgentStartEvent) {
    const handler = load().handlers.get("before_agent_start") as (
      e: BeforeAgentStartEvent,
    ) => unknown;
    return handler(e);
  }

  it("adds the guideline once to empty prompt guidelines", () => {
    const e = event({});
    expect(run(e)).toBeUndefined();
    expect(run(e)).toBeUndefined();
    expect(e.systemPromptOptions.promptGuidelines).toEqual([REFERENCE_GUIDELINE]);
    expect(e.systemPromptOptions.appendSystemPrompt).toBe("");
  });

  it("appends the guideline after existing prompt guidelines", () => {
    const e = event({ promptGuidelines: ["Be brief."], appendSystemPrompt: "user text" });
    expect(run(e)).toBeUndefined();
    run(e);
    expect(e.systemPromptOptions.promptGuidelines).toEqual(["Be brief.", REFERENCE_GUIDELINE]);
    expect(e.systemPromptOptions.appendSystemPrompt).toBe("user text");
  });

  it("appends the guideline once to appendSystemPrompt with a custom prompt", () => {
    const e = event({ customPrompt: "You are X.", appendSystemPrompt: "user text" });
    expect(run(e)).toBeUndefined();
    run(e);
    expect(e.systemPromptOptions.appendSystemPrompt).toBe(`user text\n\n${REFERENCE_GUIDELINE}`);
    expect(e.systemPromptOptions.promptGuidelines).toEqual([]);
  });

  it("uses the guideline alone as appendSystemPrompt when it is empty", () => {
    const e = event({ customPrompt: "You are X." });
    run(e);
    expect(e.systemPromptOptions.appendSystemPrompt).toBe(REFERENCE_GUIDELINE);
  });
});

describe("/pi-code-tree", () => {
  const entries: Record<string, unknown> = {
    u1: { type: "message", id: "u1", message: { role: "user", content: "fix the bug" } },
    u2: {
      type: "message",
      id: "u2",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look at " },
          { type: "image", data: "", mimeType: "image/png" },
          { type: "text", text: "this" },
        ],
      },
    },
    a1: { type: "message", id: "a1", message: { role: "assistant", content: [] } },
  };

  function setup(cancelled = false) {
    const ctx = {
      navigateTree: vi.fn(async () => ({ cancelled })),
      sessionManager: { getEntry: (id: string) => entries[id] },
      ui: { notify: vi.fn(), setEditorText: vi.fn() },
    };
    const command = load().commands.get("pi-code-tree");
    if (!command) throw new Error("pi-code-tree not registered");
    const run = (args: string) => command.handler(args, ctx as unknown as ExtensionCommandContext);
    return { ctx, command, run };
  }

  it("is registered with an internal description", () => {
    expect(setup().command.description).toMatch(/^Internal: pi-code/);
  });

  it.each([
    ["", /not valid JSON/],
    ["{nope", /not valid JSON/],
    ["[]", /JSON object/],
    ["null", /JSON object/],
    ["{}", /entryId/],
    ['{"entryId":""}', /entryId/],
    ['{"entryId":5}', /entryId/],
    ['{"entryId":"a1","summarize":"yes"}', /summarize/],
    ['{"entryId":"a1","customInstructions":1}', /customInstructions/],
  ])("rejects %j", async (args, message) => {
    const { ctx, run } = setup();
    await run(args);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(message), "error");
    expect(ctx.navigateTree).not.toHaveBeenCalled();
  });

  it("navigates with summarize options and leaves the editor alone for non-user targets", async () => {
    const { ctx, run } = setup();
    await run('{"entryId":"a1","summarize":true,"customInstructions":"focus on tests"}');
    expect(ctx.navigateTree).toHaveBeenCalledWith("a1", {
      summarize: true,
      customInstructions: "focus on tests",
    });
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("puts string user content into the editor", async () => {
    const { ctx, run } = setup();
    await run('{"entryId":"u1"}');
    expect(ctx.navigateTree).toHaveBeenCalledWith("u1", {
      summarize: undefined,
      customInstructions: undefined,
    });
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("fix the bug");
  });

  it("puts the text blocks of array user content into the editor", async () => {
    const { ctx, run } = setup();
    await run(' {"entryId":"u2"} ');
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("look at this");
  });

  it("leaves the editor alone when navigation is cancelled", async () => {
    const { ctx, run } = setup(true);
    await run('{"entryId":"u1"}');
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
  });
});
