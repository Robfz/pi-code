import type { GitDiffResponse, GitFileDiff } from "@pi-code/protocol";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "@/components/diff/testing";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { useDrafts } from "@/store/drafts";
import { stubMatchMedia } from "@/test/dom-stubs";
import { type FetchCall, hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { ChangesView } from "./changes-view";
import { useReviewStore } from "./review-state";

beforeAll(stubCanvas);
afterEach(() => vi.unstubAllGlobals());

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

async function expand(path: string) {
  const row = (await screen.findAllByTestId("diff-file")).find(
    (r) => r.dataset.path === path,
  ) as HTMLElement;
  await userEvent.setup().click(within(row).getByRole("button", { expanded: false }));
  return row;
}

describe("ChangesView", () => {
  it("switches modes, defaulting the base to the default branch", async () => {
    const { calls } = serve();
    await renderView();
    expect(await screen.findByText("No changes. The working tree is clean.")).toBeInTheDocument();
    expect(diffSearches(calls)).toEqual([""]);
    expect(calls.some((call) => call.url.endsWith("/git/branches"))).toBe(false);

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Branch" }));
    expect(await screen.findByText("No changes against main.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Base branch" })).toHaveValue("main");
    expect(diffSearches(calls)).toEqual(["", "?base=main"]);

    await user.click(screen.getByRole("checkbox", { name: "Include uncommitted" }));
    await waitFor(() =>
      expect(diffSearches(calls)).toEqual(["", "?base=main", "?base=main&uncommitted=1"]),
    );

    await user.selectOptions(screen.getByRole("combobox", { name: "Base branch" }), "dev");
    expect(await screen.findByText("No changes against dev.")).toBeInTheDocument();
    expect(diffSearches(calls).at(-1)).toBe("?base=dev&uncommitted=1");
    expect(useReviewStore.getState().reviews.a1?.diff).toEqual({
      mode: "branch",
      base: "dev",
      uncommitted: true,
    });

    await user.click(screen.getByRole("radio", { name: "Uncommitted" }));
    expect(await screen.findByText("No changes. The working tree is clean.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Base branch" })).toBeNull();
  });

  it("keeps a chosen base across remounts", async () => {
    useReviewStore.getState().setDiffMode("a1", { mode: "branch", base: "feat" });
    const { calls } = serve();
    await renderView();
    expect(await screen.findByText("No changes against feat.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Base branch" })).toHaveValue("feat");
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
      await userEvent
        .setup()
        .selectOptions(screen.getByRole("combobox", { name: "Base branch" }), "feat");
      expect(await screen.findByText("No changes against feat.")).toBeInTheDocument();
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
    const picker = screen.getByRole("combobox", { name: "Base branch" });
    expect(picker).toHaveValue("gone");
    await userEvent.setup().selectOptions(picker, "main");
    expect(await screen.findByTestId("diff-file")).toHaveAttribute("data-path", "a.ts");
  });

  it("says when the project isn't a git repository", async () => {
    stubFetch(() => [404, { error: { code: "not_a_git_repo", message: "Not a git repository" } }]);
    await renderView();
    expect(await screen.findByText("This project isn't a git repository.")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Branch" })).toBeNull();
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
      const row = await expand("notes.txt");
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
      const a = await expand("a.ts");
      await tap(a, "new", 2);
      expect(draftText()).toBe("@2222222:./a.ts:2 ");
      useDrafts.setState({ drafts: {} });
      const b = await expand("b.ts");
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
      const row = await expand("a.ts");
      await tap(row, "new", 2);
      expect(draftText()).toBe("@a.ts:2 ");
    });
  });
});
