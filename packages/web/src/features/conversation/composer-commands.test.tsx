import {
  type BashResult,
  initialLiveState,
  type RpcSessionState,
  type ServerEvent,
} from "@pi-code/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAgent } from "@/test/fixtures";
import { type FetchCall, hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { ActionSheets } from "./action-sheets";
import { Composer } from "./composer";
import { useConversationUi } from "./conversation-ui";
import {
  BUILTIN_COMMANDS,
  filterSlashItems,
  parseBash,
  parseSlash,
  slashQuery,
} from "./slash-commands";
import { LiveSection } from "./transcript/live-section";
import { TUI_ONLY_MESSAGE } from "./use-builtin-commands";

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return {
    ...actual,
    toast: Object.assign(vi.fn(), {
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    }),
  };
});

type Model = NonNullable<RpcSessionState["model"]>;

function model(provider: string, id: string, input: ("text" | "image")[] = ["text"]): Model {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider,
    baseUrl: "",
    reasoning: true,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  } as Model;
}

function state(input: ("text" | "image")[] = ["text"]): RpcSessionState {
  return {
    model: model("anthropic", "claude-sonnet-4-5", input),
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    sessionId: "s1",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
}

const COMMANDS = [
  { name: "mcp-auth", description: "Authenticate an MCP server", source: "extension" },
  { name: "skill:review", description: "Review code", source: "skill" },
  { name: "commit", description: "Write a commit message", source: "prompt" },
  { name: "pi-code-tree", description: "internal", source: "extension" },
];

function handler(call: FetchCall): [number, unknown] | undefined {
  if (call.url !== "/api/agents/a1/rpc") return undefined;
  const body = call.body as { type: string };
  switch (body.type) {
    case "get_commands":
      return [200, { data: { commands: COMMANDS } }];
    case "new_session":
    case "clone":
      return [200, { data: { cancelled: false } }];
    case "get_available_models":
      return [200, { data: { models: [model("openai", "gpt-5"), model("anthropic", "haiku")] } }];
    case "get_available_thinking_levels":
      return [200, { data: { levels: ["off", "high"] } }];
    case "get_fork_messages":
      return [200, { data: { messages: [{ entryId: "u1", text: "hi" }] } }];
    case "get_session_stats":
      return [200, { data: undefined }];
    case "get_last_assistant_text":
      return [200, { data: { text: "the answer" } }];
    case "bash":
      return [202, { data: { id: "bash-1" } }];
    default:
      return [200, {}];
  }
}

const rpcBodies = (calls: FetchCall[]) =>
  calls
    .filter((c) => c.url === "/api/agents/a1/rpc")
    .map((c) => c.body)
    .filter((b) => (b as { type: string }).type !== "get_commands");

async function setup(input: ("text" | "image")[] = ["text"]) {
  const fetchStub = stubFetch(handler);
  const store = hydratedStore({ agent: makeAgent(), state: state(input) });
  const result = await renderWithStore(
    <>
      <LiveSection />
      <Composer />
      <ActionSheets />
    </>,
    store,
  );
  return { ...result, ...fetchStub, store, user: userEvent.setup() };
}

const box = () => screen.getByRole("textbox", { name: "Message" });

beforeEach(() => {
  useConversationUi.getState().reset();
  for (const fn of [toast.info, toast.error, toast.success]) vi.mocked(fn).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slash parsing", () => {
  it("parses queries, commands and bash prefixes", () => {
    expect(slashQuery("/co")).toBe("co");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/name x")).toBeNull();
    expect(slashQuery("hello")).toBeNull();
    expect(parseSlash("/name  My session ")).toEqual({ name: "name", args: "My session" });
    expect(parseSlash("/tree")).toEqual({ name: "tree", args: "" });
    expect(parseSlash("not /a command")).toBeNull();
    expect(parseBash("!ls -la")).toEqual({ command: "ls -la", excludeFromContext: false });
    expect(parseBash("!! git status")).toEqual({ command: "git status", excludeFromContext: true });
    expect(parseBash("!")).toBeNull();
    expect(parseBash("hello!")).toBeNull();
  });

  it("filters by prefix first, then substring", () => {
    const names = filterSlashItems(BUILTIN_COMMANDS, "co").map((i) => i.name);
    expect(names.slice(0, 2)).toEqual(["compact", "copy"]);
  });
});

describe("slash autocomplete", () => {
  it("lists built-ins and get_commands with source badges, without pi-code commands", async () => {
    const { user } = await setup();
    await user.type(box(), "/");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    await within(menu).findByText("/mcp-auth");
    expect(within(menu).getByText("/new")).toBeInTheDocument();
    expect(within(menu).queryByText("/pi-code-tree")).toBeNull();
    const option = (name: string) =>
      within(menu)
        .getAllByRole("option")
        .find((o) => o.textContent?.startsWith(`/${name}`)) as HTMLElement;
    expect(option("mcp-auth")).toHaveTextContent("extension");
    expect(option("mcp-auth")).toHaveTextContent("Authenticate an MCP server");
    expect(option("skill:review")).toHaveTextContent("skill");
    expect(option("commit")).toHaveTextContent("template");
    expect(option("new")).toHaveTextContent("built-in");
  });

  it("filters by the typed prefix", async () => {
    const { user } = await setup();
    await user.type(box(), "/mc");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    await waitFor(() =>
      expect(
        within(menu)
          .getAllByRole("option")
          .map((o) => o.textContent?.split(" ")[0]),
      ).toEqual([expect.stringMatching(/^\/mcp-auth/)]),
    );
    await user.type(box(), " x");
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  });

  it("keyboard: arrows move, Enter inserts a command that takes arguments", async () => {
    const { user, calls } = await setup();
    await user.type(box(), "/na");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    expect(within(menu).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(box()).toHaveValue("/name ");
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    expect(rpcBodies(calls)).toEqual([]);
  });

  it("keyboard: ArrowDown + Tab picks the next item; Escape dismisses", async () => {
    const { user } = await setup();
    await user.type(box(), "/co");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    const all = within(menu).getAllByRole("option");
    expect(all.at(-1)).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  });

  it("tap selection runs an argument-less built-in right away", async () => {
    const { user, calls } = await setup();
    await user.type(box(), "/clo");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    await user.click(within(menu).getByText("/clone"));
    await waitFor(() => expect(rpcBodies(calls)).toEqual([{ type: "clone" }]));
    expect(box()).toHaveValue("");
  });

  it("tap selection inserts extension commands for arguments", async () => {
    const { user } = await setup();
    await user.type(box(), "/mcp");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    await user.click(await within(menu).findByText("/mcp-auth"));
    expect(box()).toHaveValue("/mcp-auth ");
  });
});

/** Type a command, dismiss the menu and send it. */
async function run(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(box(), text);
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Send" }));
}

describe("built-in commands", () => {
  it("/new → new_session", async () => {
    const { user, calls } = await setup();
    await run(user, "/new");
    await waitFor(() => expect(rpcBodies(calls)).toEqual([{ type: "new_session" }]));
    expect(box()).toHaveValue("");
  });

  it("/resume → sessions for this project", async () => {
    const { user, router } = await setup();
    await run(user, "/resume");
    await waitFor(() => expect(router.state.location.pathname).toBe("/sessions"));
    expect(router.state.location.search).toEqual({ cwd: "/home/me/project" });
  });

  it("/name <name> → set_session_name; /name alone → rename sheet", async () => {
    const { user, calls } = await setup();
    await run(user, "/name Auth work");
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([{ type: "set_session_name", name: "Auth work" }]),
    );
    await run(user, "/name");
    expect(await screen.findByTestId("rename-sheet")).toBeInTheDocument();
  });

  it("/model provider/id → set_model", async () => {
    const { user, calls } = await setup();
    await run(user, "/model openai/gpt-5");
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([
        { type: "set_model", provider: "openai", modelId: "gpt-5" },
      ]),
    );
  });

  it("/model id → looks the provider up; unknown ids are an error", async () => {
    const { user, calls } = await setup();
    await run(user, "/model haiku");
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([
        { type: "get_available_models" },
        { type: "set_model", provider: "anthropic", modelId: "haiku" },
      ]),
    );
    await run(user, "/model nope");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Unknown model: nope"));
  });

  it("/model alone → model picker", async () => {
    const { user } = await setup();
    await run(user, "/model");
    expect(await screen.findByTestId("model-sheet")).toBeInTheDocument();
  });

  it("/thinking level → set_thinking_level; alone → picker; invalid → error", async () => {
    const { user, calls } = await setup();
    await run(user, "/thinking high");
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([{ type: "set_thinking_level", level: "high" }]),
    );
    await run(user, "/thinking extreme");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Unknown thinking level: extreme"),
    );
    await run(user, "/thinking");
    expect(await screen.findByTestId("thinking-sheet")).toBeInTheDocument();
  });

  it("a compaction pi rejects isn't toasted (compaction_end shows it inline)", async () => {
    const fetchStub = stubFetch((call) =>
      (call.body as { type?: string } | undefined)?.type === "compact"
        ? [502, { error: { code: "pi_error", message: "Nothing to compact" } }]
        : handler(call),
    );
    const store = hydratedStore({ agent: makeAgent(), state: state() });
    await renderWithStore(
      <>
        <LiveSection />
        <Composer />
      </>,
      store,
    );
    const user = userEvent.setup();
    await run(user, "/compact");
    await waitFor(() => expect(rpcBodies(fetchStub.calls)).toContainEqual({ type: "compact" }));
    act(() => {
      store
        .getState()
        .apply({ type: "pi", event: { type: "compaction_start", reason: "manual" } }, 1);
      store.getState().apply(
        {
          type: "pi",
          event: {
            type: "compaction_end",
            reason: "manual",
            result: undefined,
            aborted: false,
            willRetry: false,
            errorMessage: "Compaction failed: Nothing to compact",
          },
        },
        2,
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing to compact");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("/compact [instructions] → compact", async () => {
    const { user, calls } = await setup();
    await run(user, "/compact focus on tests");
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([{ type: "compact", customInstructions: "focus on tests" }]),
    );
    await run(user, "/compact");
    await waitFor(() => expect(rpcBodies(calls)).toContainEqual({ type: "compact" }));
  });

  it("/tree → tree screen", async () => {
    const { user, router } = await setup();
    await run(user, "/tree");
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1/tree"));
  });

  it("/fork → fork picker", async () => {
    const { user } = await setup();
    await run(user, "/fork");
    const sheet = await screen.findByTestId("fork-sheet");
    expect(await within(sheet).findByText("hi")).toBeInTheDocument();
  });

  it("/clone → clone", async () => {
    const { user, calls } = await setup();
    await run(user, "/clone");
    await waitFor(() => expect(rpcBodies(calls)).toEqual([{ type: "clone" }]));
  });

  it("/session → stats sheet", async () => {
    const { user, calls } = await setup();
    await run(user, "/session");
    expect(await screen.findByTestId("stats-sheet")).toBeInTheDocument();
    await waitFor(() => expect(rpcBodies(calls)).toEqual([{ type: "get_session_stats" }]));
  });

  it("/copy → copies the last assistant text", async () => {
    const { user, calls } = await setup();
    // After userEvent.setup(), which installs its own clipboard stub.
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await run(user, "/copy");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("the answer"));
    expect(rpcBodies(calls)).toEqual([{ type: "get_last_assistant_text" }]);
  });

  it("/diff → diff screen on phones", async () => {
    const { user, router } = await setup();
    await run(user, "/diff");
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1/diff"));
  });

  it.each(BUILTIN_COMMANDS.filter((c) => c.tuiOnly).map((c) => c.name))(
    "/%s → Use the TUI for this",
    async (name) => {
      const { user, calls } = await setup();
      await run(user, `/${name}`);
      await waitFor(() =>
        expect(toast.info).toHaveBeenCalledWith(TUI_ONLY_MESSAGE, expect.anything()),
      );
      expect(rpcBodies(calls)).toEqual([]);
    },
  );

  it("extension / skill / unknown commands go to pi as prompts", async () => {
    const { user, calls } = await setup();
    await run(user, "/mcp-auth github");
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([{ type: "prompt", message: "/mcp-auth github" }]),
    );
  });
});

describe("bash prefixes", () => {
  it("!cmd → bash and its output streams in the live area", async () => {
    const { user, calls, store } = await setup();
    await user.type(box(), "!ls");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(rpcBodies(calls)).toEqual([{ type: "bash", command: "ls" }]));
    expect(box()).toHaveValue("");
    act(() => {
      store
        .getState()
        .apply({ type: "bash_output", id: "bash-1", delta: "a.txt\n", command: "ls" }, 1);
    });
    const run = within(screen.getByTestId("live")).getByTestId("bash-execution");
    expect(run).toHaveTextContent("a.txt");
    expect(run).toHaveTextContent("running…");
    expect(run).not.toHaveAttribute("data-excluded");
  });

  it("!!cmd → bash excluded from context, shown muted", async () => {
    const { user, calls, store } = await setup();
    await user.type(box(), "!!git status");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([
        { type: "bash", command: "git status", excludeFromContext: true },
      ]),
    );
    const result: BashResult = {
      output: "clean\n",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    };
    const events: ServerEvent[] = [
      {
        type: "bash_output",
        id: "bash-1",
        delta: "clean\n",
        command: "git status",
        excludeFromContext: true,
      },
      { type: "bash_done", id: "bash-1", result, command: "git status", excludeFromContext: true },
    ];
    act(() => {
      events.forEach((event, i) => {
        store.getState().apply(event, i + 1);
      });
    });
    const run = within(screen.getByTestId("live")).getByTestId("bash-execution");
    expect(run).toHaveAttribute("data-excluded", "true");
    expect(run).toHaveTextContent("!! git status");
    expect(run).not.toHaveTextContent("exit 0");
  });

  it("works while a run is active", async () => {
    const fetchStub = stubFetch(handler);
    const store = hydratedStore({
      state: state(),
      live: { ...initialLiveState(), run: { active: true } },
    });
    await renderWithStore(<Composer />, store);
    const user = userEvent.setup();
    await user.type(box(), "!pwd");
    await user.click(screen.getByRole("button", { name: /Steer/ }));
    await waitFor(() =>
      expect(rpcBodies(fetchStub.calls)).toEqual([{ type: "bash", command: "pwd" }]),
    );
  });
});

describe("file attach", () => {
  const png = () =>
    new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
  const txt = (name: string, content: BlobPart = "x", type = "") =>
    new File([content], name, { type });
  const fileInput = () => screen.getByTestId("file-input") as HTMLInputElement;

  // jsdom can't decode images: report a small bitmap.
  beforeEach(() => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 640, height: 480, close() {} })),
    );
  });

  it("attaches images as thumbnails, removes them, and sends base64 ImageContent", async () => {
    const { user, calls } = await setup(["text", "image"]);
    expect(screen.getByRole("button", { name: "Attach file" })).toBeInTheDocument();
    expect(fileInput()).not.toHaveAttribute("accept");
    await user.upload(fileInput(), [png(), png()]);
    const list = await screen.findByRole("list", { name: "Attachments" });
    await waitFor(() => expect(within(list).getAllByRole("img")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Remove attachment 2" }));
    expect(within(list).getAllByRole("img")).toHaveLength(1);
    // Attachments alone can be sent.
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    await user.type(box(), "what is this?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([
        {
          type: "prompt",
          message: "what is this?",
          images: [{ type: "image", data: "iVBORw==", mimeType: "image/png" }],
        },
      ]),
    );
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });

  it("inlines text files as <file> blocks ahead of the typed text", async () => {
    const { user, calls } = await setup(["text", "image"]);
    await user.upload(fileInput(), [
      txt("a.ts", "const a = 1;\n", "video/mp2t"),
      png(),
      txt("notes", "todo"),
    ]);
    const list = await screen.findByRole("list", { name: "Attachments" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(within(list).getByText("a.ts")).toBeInTheDocument();
    expect(within(list).getByText("notes")).toBeInTheDocument();
    // With attachments, `!cmd` is a prompt, not a bash command.
    await user.type(box(), "!explain");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([
        {
          type: "prompt",
          message:
            '<file name="a.ts" length="13">\nconst a = 1;\n\n</file>\n<file name="notes" length="4">\ntodo\n</file>\n!explain',
          images: [{ type: "image", data: "iVBORw==", mimeType: "image/png" }],
        },
      ]),
    );
  });

  it("attaches text files when the model doesn't accept images, and rejects images", async () => {
    const { user, calls } = await setup(["text"]);
    await user.upload(fileInput(), [png(), txt("a.md", "# A")]);
    const list = await screen.findByRole("list", { name: "Attachments" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).queryByRole("img")).toBeNull();
    expect(toast.error).toHaveBeenCalledWith("The current model doesn't accept images (shot.png)");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(rpcBodies(calls)).toEqual([
        { type: "prompt", message: '<file name="a.md" length="3">\n# A\n</file>\n' },
      ]),
    );
  });

  it("rejects binary and empty files", async () => {
    const { user } = await setup(["text"]);
    await user.upload(fileInput(), [
      txt("app.bin", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0])),
      txt("empty.txt", ""),
    ]);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("app.bin isn't a text file"));
    expect(toast.error).toHaveBeenCalledWith("empty.txt is empty");
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });

  it("drops only images when the model switches to one without image input", async () => {
    const { user, store } = await setup(["text", "image"]);
    await user.upload(fileInput(), [png(), txt("a.ts")]);
    const list = await screen.findByRole("list", { name: "Attachments" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    act(() => {
      store.getState().apply({ type: "state", state: state(["text"]) }, 1);
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).queryByRole("img")).toBeNull();
    expect(within(list).getByText("a.ts")).toBeInTheDocument();
  });

  it("restores the typed text and attachments when sending fails", async () => {
    const { user } = await setup(["text"]);
    await user.upload(fileInput(), txt("a.ts"));
    await screen.findByRole("list", { name: "Attachments" });
    await user.type(box(), "review");
    stubFetch(() => [409, { error: { code: "agent_busy", message: "busy" } }]);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(box()).toHaveValue("review");
    expect(
      within(screen.getByRole("list", { name: "Attachments" })).getByText("a.ts"),
    ).toBeInTheDocument();
  });

  it("toasts images that can't be read, and keeps the others", async () => {
    const { user } = await setup(["text", "image"]);
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error("undecodable"));
    await user.upload(fileInput(), [png(), png()]);
    const list = await screen.findByRole("list", { name: "Attachments" });
    expect(within(list).getAllByRole("img")).toHaveLength(1);
    expect(toast.error).toHaveBeenCalledWith("Couldn't read shot.png");
  });
});
