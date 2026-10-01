import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadedDiff, stubCanvas } from "@/components/diff/testing";
import { useUiPrefs } from "@/store/ui-prefs";
import { stubMatchMedia } from "@/test/dom-stubs";
import { bashOutcome, listResult, readRange } from "./builtin";
import { langFromPath, splitNotice } from "./common";
import { fixtureToolCall, propsAt } from "./testing";
import { ToolCallView, type ToolCallViewProps } from "./tool-call-view";

beforeAll(stubCanvas);
afterEach(() => {
  useUiPrefs.setState({ toolsExpanded: false });
  vi.unstubAllGlobals();
});

const expand = () => userEvent.setup().click(screen.getByRole("button", { expanded: false }));
const header = () => screen.getByTestId("tool-call").firstElementChild as HTMLElement;

function view(props: ToolCallViewProps) {
  return render(<ToolCallView {...props} />);
}

describe("read", () => {
  it("collapsed: path; expanded: highlighted content (tool-calls fixture)", async () => {
    const call = fixtureToolCall("tool-calls", "read");
    view(propsAt(call, "end"));
    expect(header()).toHaveTextContent("readnotes.txt");
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
    expect(header()).toHaveTextContent("src/app.ts:10-14");
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
    expect(screen.getByText("ENOENT: no such file or directory")).toHaveClass("text-destructive");
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
  it("streams output from partialResult (steer-followup fixture)", () => {
    const call = fixtureToolCall("steer-followup", "bash");
    // First update is `{ content: [] }`.
    const { rerender } = view(propsAt(call, { update: 0 }));
    expect(header()).toHaveTextContent("$ sleep 2 && echo tick");
    expect(screen.getByText("Waiting for output…")).toBeInTheDocument(); // body open while running
    rerender(<ToolCallView {...propsAt(call, { update: 1 })} />);
    expect(screen.getByText("tick")).toBeInTheDocument();
    expect(screen.queryByText("exit 0")).toBeNull();

    rerender(<ToolCallView {...propsAt(call, "end")} />);
    expect(header()).toHaveTextContent("exit 0");
    expect(screen.queryByText("tick")).toBeNull(); // collapsed once done
  });

  it("expanded done state shows command, output and exit code", async () => {
    const call = fixtureToolCall("steer-followup", "bash");
    view(propsAt(call, "end"));
    await expand();
    expect(screen.getByText("tick")).toBeInTheDocument();
    expect(screen.getByText("(timeout 10s)")).toBeInTheDocument();
    expect(screen.getAllByText("exit 0")).toHaveLength(2);
  });

  it("aborted command (abort fixture)", async () => {
    const call = fixtureToolCall("abort", "bash");
    view(propsAt(call, "end"));
    expect(screen.getByTestId("tool-call")).toHaveAttribute("data-status", "error");
    expect(header()).toHaveTextContent("aborted");
    await expand();
    expect(screen.getByText("No output")).toBeInTheDocument();
  });

  it("non-zero exit code", async () => {
    view({
      toolCallId: "b1",
      toolName: "bash",
      args: { command: "false" },
      status: "error",
      isError: true,
      result: { content: [{ type: "text", text: "oops\n\nCommand exited with code 2" }] },
    });
    expect(header()).toHaveTextContent("exit 2");
    await expand();
    expect(screen.getByText("oops")).not.toHaveClass("text-destructive");
  });

  it("bashOutcome", () => {
    expect(bashOutcome("x", false)).toEqual({ outcome: { kind: "exit", code: 0 }, output: "x" });
    expect(bashOutcome("Command timed out after 5 seconds", true)).toEqual({
      outcome: { kind: "timeout", seconds: 5 },
      output: "",
    });
    expect(bashOutcome("spawn failed", true)).toEqual({ output: "spawn failed" });
  });
});

describe("edit", () => {
  it("collapsed: path and +n −m; expanded: the patch in the diff viewer (tool-calls fixture)", async () => {
    stubMatchMedia(() => false);
    const call = fixtureToolCall("tool-calls", "edit");
    view(propsAt(call, "end"));
    expect(header()).toHaveTextContent("notes.txt +1 −1");
    await expand();
    const diff = await loadedDiff();
    expect(diff).toHaveTextContent("I like banana bread.");
  });

  it("running and error states", async () => {
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
    expect(screen.getByText("Could not find the exact text in notes.txt.")).toHaveClass(
      "text-destructive",
    );
    expect(header()).not.toHaveTextContent("+");
  });
});

describe("write", () => {
  it("collapsed: path and line count; expanded: content as an all-added diff", async () => {
    stubMatchMedia(() => false);
    view({
      toolCallId: "w1",
      toolName: "write",
      args: { path: "hello.py", content: "print('hi')\nprint('bye')\n" },
      status: "done",
      isError: false,
      result: { content: [{ type: "text", text: "Successfully wrote to hello.py" }] },
    });
    expect(header()).toHaveTextContent("hello.py · 2 lines");
    await expand();
    const diff = await loadedDiff();
    expect(diff).toHaveTextContent("print('bye')");
    expect(diff.querySelectorAll('[data-operator="+"]')).toHaveLength(2);
  });
});

describe("grep / find / ls", () => {
  const grepText =
    "src/a.ts:3: const apple = 1;\nsrc/b.ts:9: apple();\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]";

  it("grep: pattern, count and result list", async () => {
    view({
      toolCallId: "g1",
      toolName: "grep",
      args: { pattern: "apple", path: "src" },
      status: "done",
      isError: false,
      result: { content: [{ type: "text", text: grepText }], details: { matchLimitReached: 100 } },
    });
    expect(header()).toHaveTextContent("/apple/ in src · 2 matches");
    await expand();
    const list = screen.getByTestId("result-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(/100 matches limit reached/)).toBeInTheDocument();
  });

  it("find with no results", async () => {
    view({
      toolCallId: "f1",
      toolName: "find",
      args: { pattern: "*.rs" },
      status: "done",
      isError: false,
      result: { content: [{ type: "text", text: "No files found matching pattern" }] },
    });
    expect(header()).toHaveTextContent("*.rs · 0 files");
    await expand();
    expect(screen.getByText("No files found matching pattern")).toBeInTheDocument();
  });

  it("ls: path and entry count; error", async () => {
    const { rerender } = view({
      toolCallId: "l1",
      toolName: "ls",
      args: { path: "src" },
      status: "done",
      isError: false,
      result: { content: [{ type: "text", text: "a.ts\nb.ts\nlib/" }] },
    });
    expect(header()).toHaveTextContent("lssrc · 3 entries");
    rerender(
      <ToolCallView
        toolCallId="l1"
        toolName="ls"
        args={{ path: "nope" }}
        status="error"
        isError
        result={{ content: [{ type: "text", text: "Path not found: nope" }] }}
      />,
    );
    await expand();
    expect(screen.getByText("Path not found: nope")).toHaveClass("text-destructive");
  });

  it("listResult", () => {
    expect(listResult({ content: [{ type: "text", text: "(empty directory)" }] })).toEqual({
      items: [],
    });
  });

  it("honours the global expand toggle", () => {
    useUiPrefs.setState({ toolsExpanded: true });
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
