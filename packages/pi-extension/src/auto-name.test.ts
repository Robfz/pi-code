import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  cleanTitle,
  EXCERPT_MAX,
  firstExchange,
  registerAutoName,
  TITLE_MAX,
  TITLE_MODEL,
} from "./auto-name.ts";

let nextId = 0;
function message(role: "user" | "assistant", content: unknown): SessionEntry {
  nextId += 1;
  return { type: "message", id: `e${nextId}`, message: { role, content } } as SessionEntry;
}
const text = (value: string) => [{ type: "text", text: value }];
const toolCall = { type: "toolCall", id: "t1", name: "read", arguments: {} };

describe("firstExchange", () => {
  it("is undefined until the first reply has text", () => {
    expect(firstExchange([])).toBeUndefined();
    expect(firstExchange([message("user", "fix it")])).toBeUndefined();
    expect(firstExchange([message("user", "fix it"), message("assistant", [toolCall])])).toBe(
      undefined,
    );
  });

  it("pairs the first user message with the last reply text of the first run", () => {
    const branch = [
      { type: "model_change", id: "m" } as SessionEntry,
      message("user", text("fix the login bug")),
      message("assistant", [...text("Looking."), toolCall]),
      message("assistant", text("Fixed the token refresh.")),
      message("assistant", [toolCall]),
      message("user", "now add tests"),
      message("assistant", text("Added.")),
    ];
    expect(firstExchange(branch)).toEqual({
      user: "fix the login bug",
      assistant: "Fixed the token refresh.",
    });
  });

  it("keeps the end of the user message and the start of the reply", () => {
    const user = `<file name="a.ts">${"x".repeat(EXCERPT_MAX)}</file>\nexplain this`;
    const reply = `It parses input.${"y".repeat(EXCERPT_MAX)}`;
    const exchange = firstExchange([message("user", user), message("assistant", text(reply))]);
    expect(exchange?.user).toHaveLength(EXCERPT_MAX);
    expect(exchange?.user.endsWith("explain this")).toBe(true);
    expect(exchange?.assistant).toHaveLength(EXCERPT_MAX);
    expect(exchange?.assistant.startsWith("It parses input.")).toBe(true);
  });
});

describe("cleanTitle", () => {
  it.each([
    ["Fix login bug", "Fix login bug"],
    ['  "Fix login bug."  ', "Fix login bug"],
    ["**Fix   login bug!**", "Fix login bug"],
    ["\n\nFix login bug\nExtra line", "Fix login bug"],
  ])("cleans %j", (raw, title) => {
    expect(cleanTitle(raw)).toBe(title);
  });

  it("is undefined for empty replies", () => {
    expect(cleanTitle("")).toBeUndefined();
    expect(cleanTitle(' \n "" \n')).toBeUndefined();
  });

  it("caps long titles", () => {
    const title = cleanTitle("word ".repeat(40)) ?? "";
    expect(Array.from(title)).toHaveLength(TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("registerAutoName", () => {
  const exchange = [message("user", "fix the login bug"), message("assistant", text("Fixed."))];

  interface Options {
    branch?: SessionEntry[];
    auth?: boolean;
    model?: boolean;
    reply?: () => Promise<unknown>;
  }

  function setup({ branch = exchange, auth = true, model = true, reply }: Options = {}) {
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
    let name: string | undefined;
    const pi = {
      on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
        handlers.set(event, handler);
        return () => {};
      },
      getSessionName: () => name,
      setSessionName: vi.fn((value: string) => {
        name = value;
      }),
    } as unknown as ExtensionAPI & { setSessionName: ReturnType<typeof vi.fn> };
    registerAutoName(pi);

    const titleModel = { provider: TITLE_MODEL.provider, id: TITLE_MODEL.id };
    const streamSimple = vi.fn((_model: unknown, _context: unknown, _options: unknown) => ({
      result: reply ?? (async () => ({ stopReason: "stop", content: text("Fix login bug") })),
    }));
    const ctx = {
      sessionManager: { getBranch: () => branch },
      modelRegistry: {
        find: vi.fn(() => (model ? titleModel : undefined)),
        hasConfiguredAuth: vi.fn(() => auth),
        streamSimple,
      },
      ui: { notify: vi.fn() },
    };
    const emit = (event: string) => handlers.get(event)?.({ type: event }, ctx);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return {
      pi,
      ctx,
      emit,
      settle,
      rename: (value: string) => {
        name = value;
      },
    };
  }

  it("names the session from the first exchange", async () => {
    const { pi, ctx, emit, settle } = setup();
    expect(emit("agent_end")).toBeUndefined();
    await settle();
    expect(ctx.modelRegistry.find).toHaveBeenCalledWith("anthropic", "claude-haiku-5-5");
    const [, context, options] = ctx.modelRegistry.streamSimple.mock.calls[0] ?? [];
    expect(JSON.stringify(context)).toContain("fix the login bug");
    expect(JSON.stringify(context)).toContain("Fixed.");
    expect(options).toMatchObject({ reasoning: "low" });
    expect(pi.setSessionName).toHaveBeenCalledWith("Fix login bug");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("leaves named sessions alone", async () => {
    const { pi, ctx, emit, rename, settle } = setup();
    rename("Mine");
    emit("agent_end");
    await settle();
    expect(ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(pi.setSessionName).not.toHaveBeenCalled();
  });

  it("waits for a reply with text", async () => {
    const branch = [message("user", "hi"), message("assistant", [toolCall])];
    const { ctx, emit, settle } = setup({ branch });
    emit("agent_end");
    await settle();
    expect(ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    branch.push(message("assistant", text("Hello.")));
    emit("agent_end");
    await settle();
    expect(ctx.modelRegistry.streamSimple).toHaveBeenCalledOnce();
  });

  it("tries once per session", async () => {
    const { ctx, emit, settle } = setup({
      reply: async () => ({ stopReason: "stop", content: [] }),
    });
    emit("agent_end");
    emit("agent_end");
    await settle();
    expect(ctx.modelRegistry.streamSimple).toHaveBeenCalledOnce();
    emit("session_start");
    emit("agent_end");
    await settle();
    expect(ctx.modelRegistry.streamSimple).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["without auth", { auth: false }],
    ["without the model", { model: false }],
  ])("skips silently %s", async (_label, options) => {
    const { pi, ctx, emit, settle } = setup(options);
    emit("agent_end");
    await settle();
    expect(ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(pi.setSessionName).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it.each([
    ["an error reply", async () => ({ stopReason: "error", errorMessage: "rate limited" })],
    [
      "a rejected request",
      async () => {
        throw new Error("rate limited");
      },
    ],
  ])("warns on %s", async (_label, reply) => {
    const { pi, ctx, emit, settle } = setup({ reply });
    emit("agent_end");
    await settle();
    expect(pi.setSessionName).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Couldn't auto-name this conversation: rate limited",
      "warning",
    );
  });

  it("warns on an empty reply", async () => {
    const { ctx, emit, settle } = setup({
      reply: async () => ({ stopReason: "stop", content: text('""') }),
    });
    emit("agent_end");
    await settle();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Couldn't auto-name this conversation: empty reply",
      "warning",
    );
  });

  it("keeps a name set while the title was generating", async () => {
    const { pi, emit, rename, settle } = setup();
    emit("agent_end");
    rename("Mine");
    await settle();
    expect(pi.getSessionName()).toBe("Mine");
    expect(pi.setSessionName).not.toHaveBeenCalled();
  });

  it("drops the title and stays quiet after the session shuts down", async () => {
    let fail: (error: Error) => void = () => {};
    const { pi, ctx, emit, settle } = setup({
      reply: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    });
    emit("agent_end");
    const [, , options] = ctx.modelRegistry.streamSimple.mock.calls[0] ?? [];
    const { signal } = options as { signal: AbortSignal };
    emit("session_shutdown");
    expect(signal.aborted).toBe(true);
    fail(new Error("aborted"));
    await settle();
    expect(pi.setSessionName).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});
