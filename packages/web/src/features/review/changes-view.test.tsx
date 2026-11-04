import type { GitDiffResponse, GitFileDiff, PrAttachment } from "@pi-code/protocol";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "@/components/diff/testing";
import { queryKeys } from "@/lib/query-client";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { useDrafts } from "@/store/drafts";
import { stubMatchMedia } from "@/test/dom-stubs";
import { makeAgent } from "@/test/fixtures";
import { type FetchCall, hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { ChangesView, EXPAND_MAX_FILES, EXPAND_MAX_LINES } from "./changes-view";
import { useReviewStore } from "./review-state";

beforeAll(stubCanvas);
beforeEach(() => {
  // jsdom lacks it; cmdk scrolls its selected item into view.
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

/** Old lines 1–3, new lines 1–3: line 2 changed. */
const patch = (path: string) =>
  [`--- a/${path}`, `+++ b/${path}`, "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three", ""].join(
    "\n",
  );

const file = (path: string, extra: Partial<GitFileDiff> = {}): GitFileDiff => ({
  path,
  status: "modified",
  binary: false,
  tooLarge: false,
  patch: patch(path),
  ...extra,
});

const branches = { branches: ["feat", "main", "dev"], defaultBranch: "main" as string | null };

/** Serves branches and diffs; `diff` answers each diff request from its query string. */
function serve(diff: (search: URLSearchParams) => [number, unknown] = () => [200, { files: [] }]) {
  return stubFetch((call: FetchCall) => {
    if (call.url === "/api/agents/a1/git/branches") return [200, branches];
    if (call.url === "/api/agents/a1/git/diff") return diff(new URLSearchParams(call.search));
    return undefined;
  });
}

const diffSearches = (calls: FetchCall[]) =>
  calls.filter((call) => call.url.endsWith("/git/diff")).map((call) => call.search);

function renderView() {
  return renderWithStore(<ChangesView agentId="a1" />, hydratedStore());
}

const draftText = () => useDrafts.getState().drafts.a1?.text;

async function tap(row: HTMLElement, side: "old" | "new", line: number) {
  const span = await waitFor(() => {
    const found = row.querySelector<HTMLElement>(`[data-line-${side}-num="${line}"]`);
    if (!found) throw new Error(`no ${side} line ${line}`);
    return found;
  });
  fireEvent.mouseDown(span);
  fireEvent.mouseUp(span);
}

async function fileRow(path: string) {
  return (await screen.findAllByTestId("diff-file")).find(
    (r) => r.dataset.path === path,
  ) as HTMLElement;
}

const paths = () => screen.queryAllByTestId("diff-file").map((row) => row.dataset.path);

const basePicker = () => screen.getByRole("combobox", { name: "Base branch" });

async function pickBase(branch: string) {
  const user = userEvent.setup();
  await user.click(basePicker());
  await user.click(await screen.findByRole("option", { name: branch }));
}

/** `count` files of `lines` added lines each. */
function addedFiles(count: number, lines = 1): GitFileDiff[] {
  return Array.from({ length: count }, (_, i) => {
    const path = `src/f${i}.ts`;
    const body = Array.from({ length: lines }, (_, n) => `+line ${n}`);
    return file(path, {
      status: "added",
      patch: [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines} @@`, ...body, ""].join("\n"),
    });
  });
}

const toggles = () =>
  screen
    .getAllByTestId("diff-file")
    .map((row) => within(row).getAllByRole("button")[0]?.getAttribute("aria-expanded"));

describe("ChangesView", () => {
  it("switches modes, defaulting the base to the default branch", async () => {
    const { calls } = serve();
    await renderView();
    expect(await screen.findByText("The working tree is clean.")).toBeInTheDocument();
    expect(diffSearches(calls)).toEqual([""]);
    expect(screen.getByRole("radio", { name: "Uncommitted" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Branch" }));
    expect(await screen.findByText("No changes against main")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Branch" })).toHaveAttribute("aria-checked", "true");
    expect(basePicker()).toHaveTextContent("main");
    expect(diffSearches(calls)).toEqual(["", "?base=main"]);

    const include = screen.getByRole("switch", { name: "Include uncommitted" });
    expect(include).not.toBeChecked();
    await user.click(include);
    expect(include).toBeChecked();
    await waitFor(() =>
      expect(diffSearches(calls)).toEqual(["", "?base=main", "?base=main&uncommitted=1"]),
    );

    await pickBase("dev");
    expect(await screen.findByText("No changes against dev")).toBeInTheDocument();
    expect(diffSearches(calls).at(-1)).toBe("?base=dev&uncommitted=1");
    expect(useReviewStore.getState().reviews.a1?.diff).toEqual({
      mode: "branch",
      base: "dev",
      uncommitted: true,
    });

    await user.click(screen.getByRole("radio", { name: "Uncommitted" }));
    expect(await screen.findByText("The working tree is clean.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Base branch" })).toBeNull();
    // The active mode stays on when clicked again.
    await user.click(screen.getByRole("radio", { name: "Uncommitted" }));
    expect(useReviewStore.getState().reviews.a1?.diff.mode).toBe("uncommitted");
  });

  it("a clean tree offers to compare with the default branch", async () => {
    const { calls } = serve();
    await renderView();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Compare with main" }));
    expect(await screen.findByText("No changes against main")).toBeInTheDocument();
    expect(useReviewStore.getState().reviews.a1?.diff.mode).toBe("branch");
    expect(diffSearches(calls)).toEqual(["", "?base=main"]);
  });

  it("without a default branch the compare button names no base", async () => {
    branches.defaultBranch = null;
    try {
      serve();
      await renderView();
      await userEvent
        .setup()
        .click(await screen.findByRole("button", { name: "Compare with branch" }));
      expect(await screen.findByText("Pick a base branch to compare with.")).toBeInTheDocument();
    } finally {
      branches.defaultBranch = "main";
    }
  });

  it("keeps a chosen base across remounts", async () => {
    useReviewStore.getState().setDiffMode("a1", { mode: "branch", base: "feat" });
    const { calls } = serve();
    await renderView();
    expect(await screen.findByText("No changes against feat")).toBeInTheDocument();
    expect(basePicker()).toHaveTextContent("feat");
    expect(diffSearches(calls)).toEqual(["?base=feat"]);
  });

  it("asks for a base without a default branch", async () => {
    branches.defaultBranch = null;
    try {
      useReviewStore.getState().setDiffMode("a1", { mode: "branch" });
      const { calls } = serve();
      await renderView();
      expect(await screen.findByText("Pick a base branch to compare with.")).toBeInTheDocument();
      expect(diffSearches(calls)).toEqual([]);
      expect(basePicker()).toHaveTextContent("Pick a branch");
      await pickBase("feat");
      expect(await screen.findByText("No changes against feat")).toBeInTheDocument();
      expect(diffSearches(calls)).toEqual(["?base=feat"]);
    } finally {
      branches.defaultBranch = "main";
    }
  });

  it("shows an unknown base's error with the picker usable", async () => {
    useReviewStore.getState().setDiffMode("a1", { mode: "branch", base: "gone" });
    serve((search) =>
      search.get("base") === "gone"
        ? [400, { error: { code: "invalid_body", message: "unknown branch gone" } }]
        : [200, { files: [file("a.ts")] }],
    );
    await renderView();
    expect(
      await screen.findByText("Couldn't load the diff: unknown branch gone"),
    ).toBeInTheDocument();
    expect(basePicker()).toHaveTextContent("gone");
    await pickBase("main");
    expect(await screen.findByTestId("diff-file")).toHaveAttribute("data-path", "a.ts");
  });

  it("fetches origin on demand and refreshes the diff and branches", async () => {
    useReviewStore.getState().setDiffMode("a1", { mode: "branch" });
    let fetchStatus: [number, unknown] = [
      502,
      { error: { code: "git_failed", message: "git fetch origin failed: no origin" } },
    ];
    const { calls } = stubFetch((call: FetchCall) => {
      if (call.url === "/api/agents/a1/git/fetch") return fetchStatus;
      if (call.url === "/api/agents/a1/git/branches") return [200, branches];
      if (call.url === "/api/agents/a1/git/diff") return [200, { files: [] }];
      return undefined;
    });
    const count = (suffix: string) => calls.filter((call) => call.url.endsWith(suffix)).length;
    await renderView();
    expect(await screen.findByText("No changes against main")).toBeInTheDocument();
    expect(count("/git/fetch")).toBe(0);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't fetch: git fetch origin failed: no origin",
    );
    expect(count("/git/diff")).toBe(1);

    fetchStatus = [204, null];
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(count("/git/diff")).toBe(2));
    expect(count("/git/branches")).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls.find((call) => call.url.endsWith("/git/fetch"))?.method).toBe("POST");
  });

  it("refetches the diff when the review queries are invalidated", async () => {
    let files = [file("src/a.ts")];
    serve(() => [200, { files }]);
    const { queryClient } = await renderView();
    await waitFor(() => expect(paths()).toEqual(["src/a.ts"]));
    files = [file("src/a.ts"), file("src/b.ts")];
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.review("a1") }));
    await waitFor(() => expect(paths()).toEqual(["src/a.ts", "src/b.ts"]));
  });

  it("revalidates the diff it has, keeping it as is when unchanged", async () => {
    let version = 1;
    let files = [file("src/a.ts")];
    const conditions: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const condition = new Request(input, init).headers.get("if-none-match");
        conditions.push(condition);
        const etag = `"${version}"`;
        if (condition === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
        return new Response(JSON.stringify({ files }), { status: 200, headers: { ETag: etag } });
      }),
    );
    const { queryClient } = await renderView();
    const key = queryKeys.gitDiff("a1", "uncommitted");
    const invalidate = () =>
      act(() => queryClient.invalidateQueries({ queryKey: queryKeys.review("a1") }));
    const row = await fileRow("src/a.ts");
    const data = queryClient.getQueryData(key);

    await invalidate();
    expect(conditions).toEqual([null, '"1"']);
    expect(queryClient.getQueryData(key)).toBe(data);
    expect(await fileRow("src/a.ts")).toBe(row);

    version = 2;
    files = [file("src/a.ts"), file("src/b.ts")];
    await invalidate();
    expect(conditions).toEqual([null, '"1"', '"1"']);
    await waitFor(() => expect(paths()).toEqual(["src/a.ts", "src/b.ts"]));
  });

  it("says when the project isn't a git repository", async () => {
    stubFetch(() => [404, { error: { code: "not_a_git_repo", message: "Not a git repository" } }]);
    await renderView();
    expect(await screen.findByText("This project isn't a git repository.")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Branch" })).toBeNull();
  });

  describe("files", () => {
    it("expands every file under its header, with totals and a file list", async () => {
      const { calls } = serve(() => [
        200,
        {
          files: [
            file("src/lib/app.ts"),
            file("notes.txt", { status: "renamed", oldPath: "old.txt" }),
          ],
        },
      ]);
      await renderView();
      const app = await fileRow("src/lib/app.ts");
      expect(toggles()).toEqual(["true", "true"]);
      await waitFor(() => expect(screen.getAllByTestId("diff-viewer")).toHaveLength(2));
      expect(within(app).getByTitle("Modified")).toHaveTextContent("M");
      expect(within(app).getByTitle("src/lib/app.ts")).toHaveTextContent("src/lib/app.ts");
      expect(within(await fileRow("notes.txt")).getByTitle("old.txt → notes.txt")).toBeVisible();
      expect(screen.getByText("2 files")).toBeInTheDocument();
      const list = screen.getByRole("navigation", { name: "Changed files" });
      expect(within(list).getAllByRole("button")).toHaveLength(2);

      await userEvent.setup().click(within(app).getByRole("button", { expanded: true }));
      expect(toggles()).toEqual(["false", "true"]);
      expect(screen.getAllByTestId("diff-viewer")).toHaveLength(1);
      expect(calls.some((call) => call.url.endsWith("/git/branches"))).toBe(false);
    });

    it(`starts collapsed past ${EXPAND_MAX_FILES} files`, async () => {
      serve(() => [200, { files: addedFiles(EXPAND_MAX_FILES + 1) }]);
      await renderView();
      await screen.findAllByTestId("diff-file");
      expect(new Set(toggles())).toEqual(new Set(["false"]));
      expect(screen.queryByTestId("diff-viewer")).toBeNull();
    });

    it(`starts collapsed past ${EXPAND_MAX_LINES} changed lines`, async () => {
      serve(() => [200, { files: addedFiles(2, EXPAND_MAX_LINES / 2 + 1) }]);
      await renderView();
      await screen.findAllByTestId("diff-file");
      expect(toggles()).toEqual(["false", "false"]);
    });

    it("a file in the list opens and scrolls to its diff", async () => {
      const scrolled: Element[] = [];
      Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
        scrolled.push(this);
      });
      serve(() => [200, { files: addedFiles(EXPAND_MAX_FILES + 1) }]);
      await renderView();
      const list = await screen.findByRole("navigation", { name: "Changed files" });
      await userEvent.setup().click(within(list).getByRole("button", { name: /f7\.ts/ }));
      const row = await fileRow("src/f7.ts");
      expect(scrolled).toEqual([row]);
      expect(within(row).getAllByRole("button")[0]).toHaveAttribute("aria-expanded", "true");
      expect(await within(row).findByTestId("diff-viewer")).toBeInTheDocument();
    });
  });

  describe("references", () => {
    it("uncommitted mode: old lines name the old commit, new lines are unversioned", async () => {
      stubMatchMedia((query) => query === DESKTOP_QUERY);
      const response: GitDiffResponse = {
        files: [file("notes.txt", { status: "renamed", oldPath: "old.txt" })],
        oldRev: "abc1234",
      };
      serve(() => [200, response]);
      await renderView();
      const row = await fileRow("notes.txt");
      await tap(row, "old", 2);
      expect(draftText()).toBe("@abc1234:./old.txt:2 ");
      useDrafts.setState({ drafts: {} });
      await tap(row, "new", 2);
      expect(draftText()).toBe("@notes.txt:2 ");
    });

    it("branch mode without uncommitted: HEAD lines are versioned only when the working tree differs", async () => {
      stubMatchMedia((query) => query === DESKTOP_QUERY);
      useReviewStore.getState().setDiffMode("a1", { mode: "branch" });
      const response: GitDiffResponse = {
        files: [file("a.ts", { worktreeChanged: true }), file("b.ts")],
        oldRev: "1111111",
        newRev: "2222222",
      };
      serve(() => [200, response]);
      await renderView();
      const a = await fileRow("a.ts");
      await tap(a, "new", 2);
      expect(draftText()).toBe("@2222222:./a.ts:2 ");
      useDrafts.setState({ drafts: {} });
      const b = await fileRow("b.ts");
      await tap(b, "new", 2);
      expect(draftText()).toBe("@b.ts:2 ");
      useDrafts.setState({ drafts: {} });
      await tap(b, "old", 2);
      expect(draftText()).toBe("@1111111:./b.ts:2 ");
    });

    it("branch mode with uncommitted: the working-tree side is unversioned", async () => {
      stubMatchMedia((query) => query === DESKTOP_QUERY);
      useReviewStore.getState().setDiffMode("a1", { mode: "branch", uncommitted: true });
      serve(() => [200, { files: [file("a.ts")], oldRev: "1111111" }]);
      await renderView();
      const row = await fileRow("a.ts");
      await tap(row, "new", 2);
      expect(draftText()).toBe("@a.ts:2 ");
    });
  });

  describe("PR mode", () => {
    const SESSION = "/sessions/s.jsonl";
    const PR: PrAttachment = {
      repo: "o/r",
      number: 12,
      title: "Speed up the parser",
      url: "https://github.com/o/r/pull/12",
      state: "open",
      baseRefName: "main",
      headRefName: "fast",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      remoteHeadSha: "b".repeat(40),
    };

    /**
     * The view for a conversation attached to `pr`; serves its diff and refresh, which answers
     * `refreshed` (default: `pr`).
     */
    async function renderAttached(pr: PrAttachment, refreshed: [number, unknown] = [200, { pr }]) {
      const fetched = stubFetch((call: FetchCall) => {
        if (call.url === "/api/agents/a1/git/diff") {
          return [200, { files: [file("a.ts")], oldRev: "aaaaaaa", newRev: "bbbbbbb" }];
        }
        if (call.url === "/api/agents/a1/pr/refresh") return refreshed;
        if (call.url === "/api/agents/a1/git/branches") return [200, branches];
        return undefined;
      });
      const store = hydratedStore({ agent: makeAgent({ id: "a1", sessionFile: SESSION }) });
      const rendered = await renderWithStore(<ChangesView agentId="a1" />, store);
      act(() => rendered.registry.live.setState({ prs: { [SESSION]: pr } }));
      return { ...rendered, calls: fetched.calls };
    }

    it("is the default once attached, beside Uncommitted and Branch", async () => {
      const { calls } = await renderAttached(PR);
      expect(await fileRow("a.ts")).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "PR" })).toHaveAttribute("aria-checked", "true");
      expect(diffSearches(calls)).toContain("?pr=1");
      await userEvent.setup().click(screen.getByRole("radio", { name: "Uncommitted" }));
      expect(screen.queryByTestId("pr-header")).toBeNull();
      expect(useReviewStore.getState().reviews.a1?.diff.mode).toBe("uncommitted");
    });

    it("isn't offered without an attachment", async () => {
      serve();
      await renderView();
      expect(await screen.findByText("The working tree is clean.")).toBeInTheDocument();
      expect(screen.queryByRole("radio", { name: "PR" })).toBeNull();
    });

    it("heads the diff with the PR, a state chip only when merged or closed", async () => {
      await renderAttached(PR);
      const header = await screen.findByTestId("pr-header");
      expect(within(header).getByRole("link", { name: "#12" })).toHaveAttribute("href", PR.url);
      expect(header).toHaveTextContent("#12 Speed up the parser");
      expect(header).not.toHaveTextContent(/Merged|Closed|Outdated/);
    });

    it.each([
      ["merged", "Merged"],
      ["closed", "Closed"],
    ] as const)("shows a %s PR's state", async (state, label) => {
      await renderAttached({ ...PR, state });
      expect(await screen.findByTestId("pr-header")).toHaveTextContent(label);
    });

    it("shows Outdated · Refresh after newer pushes; Refresh re-pins the PR and reloads its diff", async () => {
      const { calls, registry } = await renderAttached({ ...PR, remoteHeadSha: "c".repeat(40) });
      const header = await screen.findByTestId("pr-header");
      expect(header).toHaveTextContent("Outdated ·");
      await fileRow("a.ts");
      const prDiffs = () => diffSearches(calls).filter((search) => search === "?pr=1");
      expect(prDiffs()).toHaveLength(1);
      await userEvent.setup().click(within(header).getByRole("button", { name: "Refresh" }));
      await waitFor(() =>
        expect(calls.filter((call) => call.method === "POST").map((call) => call.url)).toEqual([
          "/api/agents/a1/pr/refresh",
        ]),
      );
      // The server's `prs` frame with the re-pinned commits.
      const repinned = { ...PR, headSha: "c".repeat(40), remoteHeadSha: "c".repeat(40) };
      act(() => registry.live.setState({ prs: { [SESSION]: repinned } }));
      await waitFor(() => expect(prDiffs()).toHaveLength(2));
      expect(screen.getByTestId("pr-header")).not.toHaveTextContent("Outdated");
    });

    it("toasts why a refresh failed, still Outdated", async () => {
      const error = vi.spyOn(toast, "error").mockImplementation(() => "");
      await renderAttached({ ...PR, remoteHeadSha: "c".repeat(40) }, [
        502,
        { error: { code: "gh_failed", message: "gh isn't logged in to GitHub" } },
      ]);
      const header = await screen.findByTestId("pr-header");
      await userEvent.setup().click(within(header).getByRole("button", { name: "Refresh" }));
      await waitFor(() =>
        expect(error).toHaveBeenCalledWith("Couldn't refresh the PR: gh isn't logged in to GitHub"),
      );
      expect(header).toHaveTextContent("Outdated ·");
      expect(within(header).getByRole("button", { name: "Refresh" })).toBeEnabled();
    });

    it("keeps the pinned PR diff when the review queries are invalidated", async () => {
      const { calls, queryClient } = await renderAttached(PR);
      await fileRow("a.ts");
      const loaded = diffSearches(calls).length;
      await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.review("a1") }));
      expect(diffSearches(calls)).toHaveLength(loaded);
    });

    it("names the PR head in new-side references: it isn't on disk", async () => {
      stubMatchMedia((query) => query === DESKTOP_QUERY);
      await renderAttached(PR);
      const row = await fileRow("a.ts");
      await tap(row, "new", 2);
      expect(draftText()).toBe("@bbbbbbb:./a.ts:2 ");
      useDrafts.setState({ drafts: {} });
      await tap(row, "old", 2);
      expect(draftText()).toBe("@aaaaaaa:./a.ts:2 ");
    });
  });
});
