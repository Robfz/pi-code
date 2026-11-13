import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadedDiff, stubCanvas } from "@/components/diff/testing";
import { ConversationStoreProvider } from "@/store/context";
import { useUiPrefs } from "@/store/ui-prefs";
import { stubMatchMedia } from "@/test/dom-stubs";
import { hydratedStore } from "@/test/render";
import { bashOutcome, listResult, readRange, splitCd } from "./builtin";
import { langFromPath, splitNotice } from "./common";
import { fixtureToolCall, propsAt, rowBody, rowParts } from "./testing";
import { ToolCallView, type ToolCallViewProps } from "./tool-call-view";

beforeAll(stubCanvas);
afterEach(() => {
  useUiPrefs.setState({ density: "balanced" });
  vi.unstubAllGlobals();
});

const expand = () => userEvent.setup().click(screen.getByRole("button", { expanded: false }));
const row = () => screen.getByTestId("tool-call");
const label = () => rowParts(row());
const body = () => rowBody(row());

function view(props: ToolCallViewProps) {
  const store = hydratedStore();
  return render(<ToolCallView {...props} />, {
    wrapper: ({ children }) => (
      <ConversationStoreProvider store={store}>{children}</ConversationStoreProvider>
    ),
  });
}

describe("read", () => {
  it("row: running, done and failed (tool-calls fixture)", () => {
    const call = fixtureToolCall("tool-calls", "read");
    const { rerender } = view(propsAt(call, "start"));
    expect(label()).toMatchObject({
      icon: "file-text",
      verb: "Reading",
      shimmer: true,
      target: "notes.txt",
      meta: undefined,
    });
    rerender(<ToolCallView {...propsAt(call, "end")} />);
    expect(label()).toMatchObject({ verb: "Read", shimmer: false, target: "notes.txt" });
    rerender(
      <ToolCallView
        {...call}
        status="error"
        isError
        result={{ content: [{ type: "text", text: "ENOENT: no such file\nmore" }] }}
      />,
    );
    expect(label()).toMatchObject({
      icon: "circle-alert",
      verb: "Read failed",
      meta: "ENOENT: no such file",
    });
  });

  it("collapsed: no body; expanded: highlighted content (tool-calls fixture)", async () => {
    const call = fixtureToolCall("tool-calls", "read");
    view(propsAt(call, "end"));
    expect(screen.queryByTestId("code-block")).toBeNull();
    await expand();
    const block = screen.getByTestId("code-block");
    expect(block).toHaveAttribute("data-lang", "text");
    expect(await within(block).findByText(/I like apple pie\./)).toBeInTheDocument();
  });

  it("shows the line range, the language, and pi's truncation notice", async () => {
    view({
      toolCallId: "r1",
      toolName: "read",
      args: { path: "src/app.ts", offset: 10, limit: 5 },
      status: "done",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "const a = 1;\n\n[Showing lines 10-14 of 200. Use offset=15 to continue.]",
          },
        ],
      },
    });
    // The directory follows the basename (hidden below 1024px).
    expect(label()).toMatchObject({ target: "app.tssrc", meta: ":10-14" });
    await expand();
    expect(screen.getByTestId("code-block")).toHaveAttribute("data-lang", "typescript");
    expect(
      screen.getByText("Showing lines 10-14 of 200. Use offset=15 to continue."),
    ).toBeInTheDocument();
  });

  it("error", async () => {
    view({
      toolCallId: "r2",
      toolName: "read",
      args: { path: "missing.txt" },
      status: "error",
      isError: true,
      result: { content: [{ type: "text", text: "ENOENT: no such file or directory" }] },
    });
    await expand();
    expect(within(body()).getByText("ENOENT: no such file or directory")).toHaveClass(
      "text-destructive",
    );
  });

  it("helpers", () => {
    expect(readRange({ path: "a", offset: 1, limit: null })).toBeUndefined();
    expect(readRange({ path: "a", offset: 5 })).toBe(":5-");
    expect(readRange({ path: "a", limit: 3 })).toBe(":1-3");
    expect(langFromPath("x/Main.TSX")).toBe("tsx");
    expect(langFromPath("Dockerfile")).toBe("docker");
    expect(langFromPath("notes")).toBe("text");
    expect(splitNotice("a\nb\n\n[50 more lines in file. Use offset=3 to continue.]")).toEqual({
      body: "a\nb",
      notice: "50 more lines in file. Use offset=3 to continue.",
    });
  });
});

describe("bash", () => {
  it("streams output from partialResult, expanded while running (steer-followup fixture)", () => {
    const call = fixtureToolCall("steer-followup", "bash");
    // First update is `{ content: [] }`.
    const { rerender } = view(propsAt(call, { update: 0 }));
    expect(label()).toMatchObject({
      icon: "square-terminal",
      verb: "Running",
      shimmer: true,
      target: "sleep 2 && echo tick",
      meta: undefined,
    });
    expect(screen.getByText("Waiting for output…")).toBeInTheDocument(); // body open while running
    rerender(<ToolCallView {...propsAt(call, { update: 1 })} />);
    expect(screen.getByText("tick")).toBeInTheDocument();

    rerender(<ToolCallView {...propsAt(call, "end")} />);
    expect(label()).toMatchObject({ verb: "Ran", shimmer: false, meta: undefined }); // exit 0
    expect(screen.queryByText("tick")).toBeNull(); // collapsed once done
  });

  it("expanded done state shows command, output and exit code", async () => {
    const call = fixtureToolCall("steer-followup", "bash");
    view(propsAt(call, "end"));
    await expand();
    expect(screen.getByText("tick")).toBeInTheDocument();
    expect(screen.getByText("(timeout 10s)")).toBeInTheDocument();
    expect(screen.getByText("exit 0")).toHaveClass("text-faint-foreground");
  });

  it("aborted command (abort fixture)", async () => {
    const call = fixtureToolCall("abort", "bash");
    view(propsAt(call, "end"));
    expect(row()).toHaveAttribute("data-status", "error");
    expect(label()).toMatchObject({
      icon: "circle-alert",
      verb: "Command failed",
      meta: "Command aborted",
    });
    await expand();
    expect(screen.getByText("No output")).toBeInTheDocument();
  });

  it("non-zero exit code", async () => {
    view({
      toolCallId: "b1",
      toolName: "bash",
      args: { command: "false\nsecond line" },
      status: "error",
      isError: true,
      result: { content: [{ type: "text", text: "oops\n\nCommand exited with code 2" }] },
    });
    expect(label()).toMatchObject({
      verb: "Command failed",
      target: "false",
      meta: "exit 2 · oops",
    });
    await expand();
    expect(within(body()).getByText("oops")).not.toHaveClass("text-destructive");
    expect(within(body()).getByText("exit 2")).toHaveClass("text-status-error");
  });

  it("bashOutcome", () => {
    expect(bashOutcome("x", false)).toEqual({ outcome: { kind: "exit", code: 0 }, output: "x" });
    expect(bashOutcome("Command timed out after 5 seconds", true)).toEqual({
      outcome: { kind: "timeout", seconds: 5 },
      output: "",
    });
    expect(bashOutcome("spawn failed", true)).toEqual({ output: "spawn failed" });
  });

  it("splitCd", () => {
    expect(splitCd("cd /a/b && pnpm test")).toEqual({ dir: "/a/b", command: "pnpm test" });
    expect(splitCd("cd src; ls")).toEqual({ dir: "src", command: "ls" });
    expect(splitCd("cd x&&ls -la")).toEqual({ dir: "x", command: "ls -la" });
    expect(splitCd("  cd x &&\n  make")).toEqual({ dir: "x", command: "make" });
    expect(splitCd('cd "/my dir" && ls')).toEqual({ dir: "/my dir", command: "ls" });
    expect(splitCd("cd '/my dir' && ls")).toEqual({ dir: "/my dir", command: "ls" });
    expect(splitCd("cd /my\\ dir && ls")).toEqual({ dir: "/my dir", command: "ls" });
    // Only the first cd goes; the rest of the chain stays.
    expect(splitCd("cd a && cd b && ls")).toEqual({ dir: "a", command: "cd b && ls" });
    for (const unchanged of [
      "ls && cd x",
      "cd x",
      "cd x && ",
      "cd x || exit 1",
      "cd $(git rev-parse --show-toplevel) && ls",
      "cdx && ls",
      "bash -lc 'cd x && ls'",
    ]) {
      expect(splitCd(unchanged)).toEqual({ command: unchanged });
    }
  });

  it("row: drops a cd into the conversation's folder, shows another dir before the command", () => {
    const store = hydratedStore();
    const cwd = store.getState().agent.cwd;
    const call = (id: string, command: string) => (
      <div data-testid={id}>
        <ToolCallView
          toolCallId={id}
          toolName="bash"
          args={{ command }}
          status="done"
          isError={false}
          result={{ content: [] }}
        />
      </div>
    );
    render(
      <ConversationStoreProvider store={store}>
        {call("cwd", `cd ${cwd}/ && pnpm test`)}
        {call("inside", `cd "${cwd}/packages/web" && pnpm test`)}
        {call("relative", "cd src; ls")}
        {call("outside", "cd /tmp && ls")}
      </ConversationStoreProvider>,
    );
    const target = (id: string) =>
      rowParts(within(screen.getByTestId(id)).getByTestId("tool-call")).target;
    expect(target("cwd")).toBe("pnpm test");
    expect(target("inside")).toBe("packages/webpnpm test");
    expect(target("relative")).toBe("srcls");
    expect(target("outside")).toBe("/tmpls");
    expect(screen.getByText("packages/web")).toHaveClass("text-faint-foreground");
  });

  it("expanded: the body keeps the full command", async () => {
    view({
      toolCallId: "b2",
      toolName: "bash",
      args: { command: "cd /home/me/project && ls" },
      status: "done",
      isError: false,
      result: { content: [{ type: "text", text: "a.txt" }] },
    });
    expect(label().target).toBe("ls");
    await expand();
    expect(within(body()).getByText("cd /home/me/project && ls")).toBeInTheDocument();
  });
});

describe("edit", () => {
  it("row: running, done with +n −m, failed (tool-calls fixture)", () => {
    const call = fixtureToolCall("tool-calls", "edit");
    const { rerender } = view(propsAt(call, "start"));
    expect(label()).toMatchObject({
      icon: "file-pen",
      verb: "Editing",
      shimmer: true,
      target: "notes.txt",
      meta: undefined,
    });
    rerender(<ToolCallView {...propsAt(call, "end")} />);
    expect(label()).toMatchObject({ verb: "Edited", meta: "+1−1" });
    expect(within(row()).getByText("+1")).toHaveClass("text-diff-add");
    expect(within(row()).getByText("−1")).toHaveClass("text-diff-del");
    rerender(
      <ToolCallView
        {...call}
        status="error"
        isError
        result={{ content: [{ type: "text", text: "Could not find the exact text." }] }}
      />,
    );
    expect(label()).toMatchObject({
      icon: "circle-alert",
      verb: "Edit failed",
      meta: "Could not find the exact text.",
    });
    expect(screen.getByText("Edit failed")).toHaveClass("text-status-error");
  });

  it("expanded: the patch in the diff viewer (tool-calls fixture)", async () => {
    stubMatchMedia(() => false);
    const call = fixtureToolCall("tool-calls", "edit");
    view(propsAt(call, "end"));
    await expand();
    const diff = await loadedDiff();
    expect(diff).toHaveTextContent("I like banana bread.");
  });

  it("running and error bodies", async () => {
    const call = fixtureToolCall("tool-calls", "edit");
    const { rerender } = view(propsAt(call, "start"));
    await expand();
    expect(screen.getByText("Applying 1 edit…")).toBeInTheDocument();
    rerender(
      <ToolCallView
        {...call}
        status="error"
        isError
        result={{
          content: [{ type: "text", text: "Could not find the exact text in notes.txt." }],
        }}
      />,
    );
    expect(within(body()).getByText("Could not find the exact text in notes.txt.")).toHaveClass(
      "text-destructive",
    );
  });
});

describe("write", () => {
  const args = { path: "src/hello.py", content: "print('hi')\nprint('bye')\n" };

  it("row: running, done and failed", () => {
    const { rerender } = view({
      toolCallId: "w1",
      toolName: "write",
      args,
      status: "running",
      isError: false,
    });
    expect(label()).toMatchObject({
      icon: "file-plus",
      verb: "Writing",
      shimmer: true,
      target: "hello.pysrc",
      meta: "· 2 lines",
    });
    rerender(
      <ToolCallView
        toolCallId="w1"
        toolName="write"
        args={args}
        status="done"
        isError={false}
        result={{ content: [{ type: "text", text: "Successfully wrote to hello.py" }] }}
      />,
    );
    expect(label()).toMatchObject({ verb: "Wrote", meta: "· 2 lines" });
    rerender(
      <ToolCallView
        toolCallId="w1"
        toolName="write"
        args={args}
        status="error"
        isError
        result={{ content: [{ type: "text", text: "EACCES: permission denied" }] }}
      />,
    );
    expect(label()).toMatchObject({
      icon: "circle-alert",
      verb: "Write failed",
      meta: "· 2 lines · EACCES: permission denied",
    });
  });

  it("expanded: content as an all-added diff", async () => {
    stubMatchMedia(() => false);
    view({
      toolCallId: "w1",
      toolName: "write",
      args,
      status: "done",
      isError: false,
      result: { content: [{ type: "text", text: "Successfully wrote to hello.py" }] },
    });
    await expand();
    const diff = await loadedDiff();
    expect(diff).toHaveTextContent("print('bye')");
    expect(diff.querySelectorAll('[data-operator="+"]')).toHaveLength(2);
  });
});

describe("grep / find / ls", () => {
  const grepText =
    "src/a.ts:3: const apple = 1;\nsrc/b.ts:9: apple();\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]";
  const failed = { content: [{ type: "text", text: "Path not found: nope" }] };

  it("grep: running, done with pattern and count, failed; result list", async () => {
    const args = { pattern: "apple", path: "src" };
    const { rerender } = view({
      toolCallId: "g1",
      toolName: "grep",
      args,
      status: "running",
      isError: false,
    });
    expect(label()).toMatchObject({
      icon: "text-search",
      verb: "Searching",
      shimmer: true,
      target: "/apple/",
      meta: undefined,
    });
    rerender(
      <ToolCallView
        toolCallId="g1"
        toolName="grep"
        args={args}
        status="error"
        isError
        result={failed}
      />,
    );
    expect(label()).toMatchObject({ verb: "Search failed", meta: "Path not found: nope" });
    rerender(
      <ToolCallView
        toolCallId="g1"
        toolName="grep"
        args={args}
        status="done"
        isError={false}
        result={{
          content: [{ type: "text", text: grepText }],
          details: { matchLimitReached: 100 },
        }}
      />,
    );
    expect(label()).toMatchObject({ verb: "Searched", target: "/apple/", meta: "· 2 matches" });
    await expand();
    const list = screen.getByTestId("result-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(/100 matches limit reached/)).toBeInTheDocument();
  });

  it("find: running, done with no results, failed", async () => {
    const args = { pattern: "*.rs" };
    const { rerender } = view({
      toolCallId: "f1",
      toolName: "find",
      args,
      status: "running",
      isError: false,
    });
    expect(label()).toMatchObject({ icon: "file-search", verb: "Finding", target: "*.rs" });
    rerender(
      <ToolCallView
        toolCallId="f1"
        toolName="find"
        args={args}
        status="error"
        isError
        result={failed}
      />,
    );
    expect(label()).toMatchObject({ verb: "Find failed", meta: "Path not found: nope" });
    rerender(
      <ToolCallView
        toolCallId="f1"
        toolName="find"
        args={args}
        status="done"
        isError={false}
        result={{ content: [{ type: "text", text: "No files found matching pattern" }] }}
      />,
    );
    expect(label()).toMatchObject({ verb: "Found", target: "*.rs", meta: "· 0 files" });
    await expand();
    expect(screen.getByText("No files found matching pattern")).toBeInTheDocument();
  });

  it("ls: running, done with the entry count, failed", async () => {
    const { rerender } = view({
      toolCallId: "l1",
      toolName: "ls",
      args: { path: "packages/web/src" },
      status: "running",
      isError: false,
    });
    expect(label()).toMatchObject({
      icon: "folder-open",
      verb: "Listing",
      target: "srcpackages/web",
    });
    rerender(
      <ToolCallView
        toolCallId="l1"
        toolName="ls"
        args={{}}
        status="done"
        isError={false}
        result={{ content: [{ type: "text", text: "a.ts\nb.ts\nlib/" }] }}
      />,
    );
    expect(label()).toMatchObject({ verb: "Listed", target: ".", meta: "· 3 entries" });
    rerender(
      <ToolCallView
        toolCallId="l1"
        toolName="ls"
        args={{ path: "nope" }}
        status="error"
        isError
        result={failed}
      />,
    );
    expect(label()).toMatchObject({ verb: "List failed", target: "nope" });
    await expand();
    expect(within(body()).getByText("Path not found: nope")).toHaveClass("text-destructive");
  });

  it("listResult", () => {
    expect(listResult({ content: [{ type: "text", text: "(empty directory)" }] })).toEqual({
      items: [],
    });
  });

  it("is expanded in Detailed density", () => {
    useUiPrefs.setState({ density: "detailed" });
    view({
      toolCallId: "l2",
      toolName: "ls",
      args: {},
      status: "done",
      isError: false,
      result: { content: [{ type: "text", text: "only.txt" }] },
    });
    expect(screen.getByText("only.txt")).toBeInTheDocument();
  });
});
