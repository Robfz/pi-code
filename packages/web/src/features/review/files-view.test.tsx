import type { FileContentResponse } from "@pi-code/protocol";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "@/components/diff/testing";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { useDrafts } from "@/store/drafts";
import { stubMatchMedia } from "@/test/dom-stubs";
import { type FetchCall, hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { FILE_SEARCH_DEBOUNCE_MS, FilesView } from "./files-view";
import { useReviewStore } from "./review-state";

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: Object.assign(vi.fn(), { error: vi.fn() }) };
});

beforeAll(stubCanvas);

let scrolled: Element[];
beforeEach(() => {
  stubMatchMedia((query) => query === DESKTOP_QUERY);
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(toast).mockClear();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`);
const text = (path: string, content: string): FileContentResponse => ({
  path,
  content,
  binary: false,
  tooLarge: false,
});

/** Serves `GET files` with `results` and `GET files/content` with `content(path)`. */
function serve({
  results = ["src/git/git.ts", "src/agents/git-helper-test.ts", "git.ts"],
  content = (path: string): [number, unknown] => [200, text(path, `${lines(5).join("\n")}\n`)],
}: {
  results?: string[];
  content?: (path: string) => [number, unknown];
} = {}) {
  return stubFetch((call: FetchCall) => {
    const search = new URLSearchParams(call.search);
    if (call.url === "/api/agents/a1/files") return [200, { files: results }];
    if (call.url === "/api/agents/a1/files/content") return content(search.get("path") ?? "");
    return undefined;
  });
}

const searches = (calls: FetchCall[]) =>
  calls
    .filter((call) => call.url === "/api/agents/a1/files")
    .map((call) => new URLSearchParams(call.search).get("q"));

function renderView() {
  return renderWithStore(<FilesView agentId="a1" />, hydratedStore());
}

const files = () => useReviewStore.getState().reviews.a1?.files;

function lineNumber(line: number) {
  return waitFor(
    () => {
      const span = document.querySelector<HTMLElement>(`[data-line-new-num="${line}"]`);
      if (!span) throw new Error(`no line ${line}`);
      return span;
    },
    { timeout: 5000 },
  );
}

/** New-side numbers of the marked rows. */
function marked(): string[] {
  return Array.from(document.querySelectorAll(".diff-line-num.diff-multi-select-active")).map(
    (cell) => cell.querySelector("[data-line-new-num]")?.getAttribute("data-line-new-num") ?? "",
  );
}

describe("FilesView search", () => {
  it("searches once after typing stops, basename first", async () => {
    const { calls } = serve();
    await renderView();
    expect(screen.getByText("Type to search files")).toBeInTheDocument();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(screen.getByRole("combobox", { name: "Search files" }), "gitts");
    expect(searches(calls)).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS));
    const options = await screen.findAllByRole("option");
    expect(searches(calls)).toEqual(["gitts"]);
    expect(options.map((option) => option.textContent)).toEqual([
      "git.tssrc/git",
      "git-helper-test.tssrc/agents",
      "git.ts",
    ]);
    expect(options[0]?.firstElementChild?.nextElementSibling?.firstElementChild).toHaveTextContent(
      /^git\.ts$/,
    );
    expect(files()?.query).toBe("gitts");
  });

  it("picks a result with the keyboard and goes back with the query kept", async () => {
    serve();
    await renderView();
    const user = userEvent.setup();
    const input = screen.getByRole("combobox", { name: "Search files" });
    await user.type(input, "git");
    await screen.findAllByRole("option");
    await waitFor(() =>
      expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true"),
    );
    await user.keyboard("{ArrowDown}{Enter}");
    expect(
      await screen.findByRole("heading", { name: "src/agents/git-helper-test.ts" }),
    ).toBeInTheDocument();
    expect(files()).toEqual({ query: "git", path: "src/agents/git-helper-test.ts" });
    expect(useReviewStore.getState().reviews.a1?.tab).toBe("files");

    await user.click(screen.getByRole("button", { name: "Back to search" }));
    expect(screen.getByRole("combobox", { name: "Search files" })).toHaveValue("git");
    expect(await screen.findAllByRole("option")).toHaveLength(3);
  });

  it("says when nothing matches", async () => {
    serve({ results: [] });
    await renderView();
    await userEvent.setup().type(screen.getByRole("combobox", { name: "Search files" }), "zzz");
    expect(await screen.findByText("No matching files")).toBeInTheDocument();
  });

  it("says when the project isn't a git repository", async () => {
    stubFetch(() => [404, { error: { code: "not_a_git_repo", message: "Not a git repository" } }]);
    await renderView();
    await userEvent.setup().type(screen.getByRole("combobox", { name: "Search files" }), "a");
    expect(await screen.findByText("This project isn't a git repository.")).toBeInTheDocument();
  });
});

describe("FilesView viewer", () => {
  it("inserts a reference to selected lines", async () => {
    serve();
    useReviewStore.getState().openFile("a1", "src/a.ts");
    await renderView();
    fireEvent.mouseDown(await lineNumber(3));
    fireEvent.mouseOver(await lineNumber(4));
    fireEvent.mouseUp(await lineNumber(4));
    expect(useDrafts.getState().drafts.a1?.text).toBe("@src/a.ts:3-4 ");
  });

  it("highlights the target and scrolls to it", async () => {
    serve();
    useReviewStore.getState().openFile("a1", "src/a.ts", { start: 3, end: 4 });
    await renderView();
    const line = await lineNumber(3);
    await waitFor(() => expect(marked()).toEqual(["3", "4"]));
    await waitFor(() => expect(scrolled).toEqual([line]));
    expect(toast).not.toHaveBeenCalled();
  });

  it("opens a target past the end without a highlight", async () => {
    serve();
    useReviewStore.getState().openFile("a1", "src/a.ts", { start: 9, end: 9 });
    await renderView();
    await lineNumber(5);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("src/a.ts has only 5 lines"));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(marked()).toEqual([]);
    expect(scrolled).toEqual([]);
  });

  it("toasts once per target when a refetch changes the line count", async () => {
    let count = 5;
    serve({ content: (path) => [200, text(path, lines(count).join("\n"))] });
    useReviewStore.getState().openFile("a1", "src/a.ts", { start: 9, end: 9 });
    const { queryClient } = await renderView();
    await waitFor(() => expect(toast).toHaveBeenCalledWith("src/a.ts has only 5 lines"));
    count = 6;
    await act(() => queryClient.refetchQueries());
    await lineNumber(6);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it.each<[string, [number, unknown]]>([
    [
      "Binary file, not shown.",
      [200, { path: "a.bin", binary: true, tooLarge: false } satisfies FileContentResponse],
    ],
    [
      "This file is too large to show (over 1 MB).",
      [200, { path: "a.log", binary: false, tooLarge: true } satisfies FileContentResponse],
    ],
    ["This file is empty.", [200, text("a.ts", "")]],
    [
      "This file no longer exists.",
      [404, { error: { code: "file_not_found", message: "File not found" } }],
    ],
    [
      "This project isn't a git repository.",
      [404, { error: { code: "not_a_git_repo", message: "Not a git repository" } }],
    ],
  ])("says %s", async (message, response) => {
    serve({ content: () => response });
    useReviewStore.getState().openFile("a1", "a.ts");
    await renderView();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to search" })).toBeInTheDocument();
  });

  it("guards a long file behind Show anyway, then highlights the target", async () => {
    serve({ content: (path) => [200, text(path, lines(2000).join("\n"))] });
    useReviewStore.getState().openFile("a1", "big.txt", { start: 1800, end: 1801 });
    await renderView();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Show anyway" }));
    const line = await lineNumber(1800);
    await waitFor(() => expect(marked()).toEqual(["1800", "1801"]), { timeout: 5000 });
    await waitFor(() => expect(scrolled).toContain(line));
    expect(toast).not.toHaveBeenCalled();
  }, 20_000);
});
