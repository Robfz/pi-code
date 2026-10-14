import type { GitDiffResponse, GitFileDiff } from "@pi-code/protocol";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "@/components/diff/testing";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { useDrafts } from "@/store/drafts";
import { stubMatchMedia } from "@/test/dom-stubs";
import { type FetchCall, hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { ChangesView, EXPAND_MAX_FILES, EXPAND_MAX_LINES } from "./changes-view";
import { useReviewStore } from "./review-state";

beforeAll(stubCanvas);
beforeEach(() => {
  // jsdom has neither; cmdk scrolls its selected item into view and measures its list.
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
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
});
