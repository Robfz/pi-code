import type { PrAttachment, PrGuideUnit } from "@pi-code/protocol";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LARGE_DIFF_LINES } from "@/components/diff";
import { loadedDiff, stubCanvas } from "@/components/diff/testing";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { useDrafts } from "@/store/drafts";
import { stubMatchMedia } from "@/test/dom-stubs";
import { sendFrame } from "@/test/fake-event-source";
import { makeAgent, makePr } from "@/test/fixtures";
import { type FetchCall, hydratedStore, renderWithStore, stubFetch } from "@/test/render";
import { EXPAND_MAX_FILES } from "./file-card";
import type { ReadyGuide } from "./guide-model";
import { A_BASE, A_HEAD, GUIDE_KEY, readyGuide } from "./guide-testing";
import { GuideView } from "./guide-view";

beforeAll(stubCanvas);
let scrolled: Element[] = [];
beforeEach(() => {
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

const SESSION = "/sessions/s.jsonl";
const PR = makePr();

type Answer = [number, unknown] | Promise<[number, unknown]>;

/**
 * GuideView in a scroll area, attached to `pr`; `guide` answers `GET …/pr/guide`, `retry` the
 * retry, and the file contents are `src/a.ts`'s.
 */
async function renderGuide({
  guide,
  retry = () => [200, { key: GUIDE_KEY, state: "generating" }],
  pr = PR,
}: {
  guide(): Answer;
  retry?(): Answer;
  pr?: PrAttachment;
}) {
  const fetched = stubFetch((call: FetchCall) => {
    if (call.url === "/api/agents/a1/pr/guide") return guide();
    if (call.url === "/api/agents/a1/pr/guide/retry") return retry();
    if (call.url === "/api/agents/a1/files/content") {
      const rev = new URLSearchParams(call.search).get("rev");
      const content = rev === PR.baseSha ? A_BASE : A_HEAD;
      return [200, { path: "src/a.ts", rev, content, binary: false, tooLarge: false }];
    }
    return undefined;
  });
  const store = hydratedStore({ agent: makeAgent({ id: "a1", sessionFile: SESSION }) });
  const rendered = await renderWithStore(
    <div data-testid="area" className="overflow-y-auto">
      <GuideView agentId="a1" />
    </div>,
    store,
  );
  act(() => rendered.registry.live.setState({ prs: { [SESSION]: pr } }));
  return { ...rendered, calls: fetched.calls };
}

const contentCalls = (calls: FetchCall[]) =>
  calls
    .filter((call) => call.url.endsWith("/files/content"))
    .map((call) => Object.fromEntries(new URLSearchParams(call.search)));

const guideCalls = (calls: FetchCall[]) =>
  calls
    .filter((call) => call.url.includes("/pr/guide"))
    .map((call) => `${call.method} ${call.url}`);

const sections = () => screen.getAllByTestId("guide-section");
const bar = () => screen.getByTestId("guide-bar");
const draftText = () => useDrafts.getState().drafts.a1?.text;

async function tap(root: HTMLElement, side: "old" | "new", line: number) {
  const span = await waitFor(
    () => {
      const found = root.querySelector<HTMLElement>(`[data-line-${side}-num="${line}"]`);
      if (!found) throw new Error(`no ${side} line ${line}`);
      return found;
    },
    { timeout: 3000 },
  );
  fireEvent.mouseDown(span);
  fireEvent.mouseUp(span);
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("GuideView", () => {
  it("shows the PR header and a plain loading state while the guide is written", async () => {
    await renderGuide({ guide: () => [200, { key: GUIDE_KEY, state: "generating" }] });
    expect(await screen.findByText("Writing the review guide…")).toBeInTheDocument();
    const header = screen.getByTestId("pr-header");
    expect(within(header).getByRole("link", { name: "#12" })).toHaveAttribute("href", PR.url);
    expect(header).toHaveTextContent("Speed up the parser");
    expect(screen.queryByTestId("guide-section")).toBeNull();
  });

  it("offers Outdated · Refresh in its header", async () => {
    const { calls } = await renderGuide({
      guide: () => [200, { key: GUIDE_KEY, state: "generating" }],
      pr: { ...PR, remoteHeadSha: "c".repeat(40) },
    });
    const header = await screen.findByTestId("pr-header");
    expect(header).toHaveTextContent("Outdated ·");
    await userEvent.setup().click(within(header).getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(calls.filter((call) => call.method === "POST").map((call) => call.url)).toEqual([
        "/api/agents/a1/pr/refresh",
      ]),
    );
  });

  it("shows a failure with Retry, disabled while the retry is pending", async () => {
    const answer = deferred<[number, unknown]>();
    const { calls } = await renderGuide({
      guide: () => [200, { key: GUIDE_KEY, state: "failed", error: "pi exited with code 1" }],
      retry: () => answer.promise,
    });
    expect(await screen.findByText("Couldn't write the review guide")).toBeInTheDocument();
    expect(screen.getByText("pi exited with code 1")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry" });
    await userEvent.setup().click(retry);
    await waitFor(() => expect(retry).toBeDisabled());
    answer.resolve([200, { key: GUIDE_KEY, state: "generating" }]);
    expect(await screen.findByText("Writing the review guide…")).toBeInTheDocument();
    expect(guideCalls(calls)).toEqual([
      "GET /api/agents/a1/pr/guide",
      "POST /api/agents/a1/pr/guide/retry",
    ]);
  });

  it("refetches when a guide frame names its key, not another's", async () => {
    let state: "generating" | ReadyGuide = "generating";
    const { calls, registry } = await renderGuide({
      guide: () => [200, state === "generating" ? { key: GUIDE_KEY, state } : state],
    });
    expect(await screen.findByText("Writing the review guide…")).toBeInTheDocument();
    registry.start();
    sendFrame({ type: "guide", key: "o/r#3@c..d", state: "ready" });
    state = readyGuide();
    sendFrame({ type: "guide", key: GUIDE_KEY, state: "ready" });
    expect(await screen.findByRole("heading", { name: /Core change/ })).toBeInTheDocument();
    expect(guideCalls(calls)).toEqual([
      "GET /api/agents/a1/pr/guide",
      "GET /api/agents/a1/pr/guide",
    ]);
    registry.stop();
  });

  it("stacks the sections, then Other changes, with explanations and file cards", async () => {
    await renderGuide({ guide: () => [200, readyGuide()] });
    await screen.findByRole("heading", { name: /Core change/ });
    const [core, followUp, other] = sections() as [HTMLElement, HTMLElement, HTMLElement];
    expect(sections()).toHaveLength(3);
    expect(core).toHaveTextContent("01Core change");
    expect(core.querySelector('[data-streamdown="strong"]')).toHaveTextContent("matters");
    const cards = within(core).getAllByTestId("diff-file");
    expect(cards.map((card) => card.dataset.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(cards[0]).toHaveTextContent("+2 −2");
    expect(within(cards[0] as HTMLElement).getByTitle("Modified")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByTitle("Added")).toBeInTheDocument();
    const text = (await loadedDiff(cards[0])).textContent ?? "";
    expect(text).toContain("LINE 2");
    expect(text).toContain("LINE 11");
    expect(text.indexOf("LINE 2")).toBeLessThan(text.indexOf("LINE 11"));

    expect(followUp).toHaveTextContent("02Follow-up");
    expect(within(followUp).getAllByTestId("diff-file")).toHaveLength(1);

    expect(other).toHaveTextContent("03Other changes");
    const [logo] = within(other).getAllByTestId("diff-file");
    expect(logo).toHaveTextContent("logo.png");
    expect(logo).toHaveTextContent("binary");
    expect(within(logo as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("has no Other changes section when nothing is left over", async () => {
    const guide = readyGuide();
    await renderGuide({ guide: () => [200, { ...guide, guide: { ...guide.guide, other: [] } }] });
    await screen.findByRole("heading", { name: /Core change/ });
    expect(sections()).toHaveLength(2);
    expect(screen.queryByText("Other changes")).toBeNull();
  });

  it("names the current section in the sticky bar; prev and next scroll to the neighbours", async () => {
    await renderGuide({ guide: () => [200, readyGuide()] });
    await screen.findByRole("heading", { name: /Core change/ });
    const user = userEvent.setup();
    const previous = within(bar()).getByRole("button", { name: "Previous section" });
    const next = within(bar()).getByRole("button", { name: "Next section" });
    expect(bar()).toHaveTextContent("Core change01 / 03");
    expect(previous).toBeDisabled();

    await user.click(next);
    expect(bar()).toHaveTextContent("Follow-up02 / 03");
    expect(scrolled).toEqual([sections()[1]]);
    await user.click(next);
    expect(bar()).toHaveTextContent("Other changes03 / 03");
    expect(next).toBeDisabled();
    await user.click(previous);
    expect(bar()).toHaveTextContent("Follow-up02 / 03");
    expect(scrolled.at(-1)).toBe(sections()[1]);
  });

  it("tracks the current section while scrolling", async () => {
    await renderGuide({ guide: () => [200, readyGuide()] });
    await screen.findByRole("heading", { name: /Core change/ });
    const area = screen.getByTestId("area");
    const rect = (top: number, bottom = top) => ({ top, bottom }) as DOMRect;
    vi.spyOn(area, "getBoundingClientRect").mockReturnValue(rect(100));
    vi.spyOn(bar(), "getBoundingClientRect").mockReturnValue(rect(100, 136));
    const tops = [-300, 20, 700];
    sections().forEach((section, i) => {
      vi.spyOn(section, "getBoundingClientRect").mockImplementation(() =>
        rect(100 + (tops[i] ?? 0)),
      );
    });
    Object.defineProperties(area, {
      scrollTop: { value: 400, writable: true },
      clientHeight: { value: 500 },
      scrollHeight: { value: 2000 },
    });

    fireEvent.scroll(area);
    expect(bar()).toHaveTextContent("Follow-up02 / 03");
    tops[1] = 200;
    fireEvent.scroll(area);
    expect(bar()).toHaveTextContent("Core change01 / 03");
    // At the end, the last section, however short.
    area.scrollTop = 1500;
    fireEvent.scroll(area);
    expect(bar()).toHaveTextContent("Other changes03 / 03");
  });

  it("keeps a jump's section over the scroll it causes, and reads the scroll after a jump that didn't", async () => {
    await renderGuide({ guide: () => [200, readyGuide()] });
    await screen.findByRole("heading", { name: /Core change/ });
    const area = screen.getByTestId("area");
    const rect = (top: number, bottom = top) => ({ top, bottom }) as DOMRect;
    vi.spyOn(area, "getBoundingClientRect").mockReturnValue(rect(100));
    vi.spyOn(bar(), "getBoundingClientRect").mockReturnValue(rect(100, 136));
    // Every section below the bar: a read scroll names the first.
    sections().forEach((section, i) => {
      vi.spyOn(section, "getBoundingClientRect").mockReturnValue(rect(300 + i * 400));
    });
    Object.defineProperties(area, {
      scrollTop: { value: 0, writable: true },
      clientHeight: { value: 500 },
      scrollHeight: { value: 2000 },
    });
    const next = within(bar()).getByRole("button", { name: "Next section" });

    fireEvent.click(next);
    fireEvent.scroll(area);
    expect(bar()).toHaveTextContent("Follow-up02 / 03");

    // No scroll follows this jump; the user's next one counts.
    fireEvent.click(next);
    expect(bar()).toHaveTextContent("Other changes03 / 03");
    await act(() => new Promise(requestAnimationFrame));
    fireEvent.scroll(area);
    expect(bar()).toHaveTextContent("Core change01 / 03");
  });

  it("collapses a section marked Reviewed, kept for this generation only", async () => {
    let guide = readyGuide();
    const { unmount } = await renderGuide({ guide: () => [200, guide] });
    await screen.findByRole("heading", { name: /Core change/ });
    const user = userEvent.setup();
    const core = () => sections()[0] as HTMLElement;
    const reviewed = () => within(core()).getByRole("checkbox", { name: "Reviewed" });
    await user.click(reviewed());
    expect(reviewed()).toBeChecked();
    expect(core()).toHaveTextContent("Core change");
    expect(within(core()).queryByTestId("diff-file")).toBeNull();
    expect(within(core()).queryByText("matters")).toBeNull();
    // No jump to the next section.
    expect(scrolled).toEqual([]);
    expect(bar()).toHaveTextContent("Core change01 / 03");
    await user.click(reviewed());
    expect(within(core()).getAllByTestId("diff-file")).toHaveLength(2);
    await user.click(reviewed());

    unmount();
    const again = await renderGuide({ guide: () => [200, guide] });
    await screen.findByRole("heading", { name: /Core change/ });
    expect(reviewed()).toBeChecked();
    expect(within(core()).queryByTestId("diff-file")).toBeNull();

    // A regenerated guide starts unmarked; the old marks go.
    guide = readyGuide({ id: "fedcba9876543210" });
    again.unmount();
    await renderGuide({ guide: () => [200, guide] });
    await waitFor(() =>
      expect(screen.getAllByRole("checkbox", { name: "Reviewed" })).toHaveLength(3),
    );
    for (const box of screen.getAllByRole("checkbox", { name: "Reviewed" })) {
      expect(box).not.toBeChecked();
    }
    expect(localStorage.getItem("pi-code:guide-reviewed")).not.toContain("0123456789abcdef");
  });

  it("starts file cards collapsed past the Changes tab's limits", async () => {
    const units: Record<string, PrGuideUnit> = {};
    for (let i = 0; i <= EXPAND_MAX_FILES; i++) {
      units[`f${i}.ts#1`] = {
        path: `f${i}.ts`,
        status: "added",
        additions: 1,
        deletions: 0,
        patch: `--- /dev/null\n+++ b/f${i}.ts\n@@ -0,0 +1 @@\n+x\n`,
      };
    }
    const guide = readyGuide({ units });
    await renderGuide({
      guide: () => [
        200,
        {
          ...guide,
          guide: {
            ...guide.guide,
            sections: [{ title: "All", explanation: "", hunks: Object.keys(units) }],
            other: [],
          },
        },
      ],
    });
    await screen.findByRole("heading", { name: /All/ });
    const cards = screen.getAllByTestId("diff-file");
    expect(cards).toHaveLength(EXPAND_MAX_FILES + 1);
    const toggle = within(cards[0] as HTMLElement).getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("diff-viewer")).toBeNull();
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await loadedDiff(cards[0])).toHaveTextContent("x");
  });

  it("starts file cards expanded within the limits; a card collapses from its header", async () => {
    await renderGuide({ guide: () => [200, readyGuide()] });
    await screen.findByRole("heading", { name: /Core change/ });
    const [card] = within(sections()[0] as HTMLElement).getAllByTestId("diff-file");
    const toggle = within(card as HTMLElement).getByRole("button", { expanded: true });
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(card as HTMLElement).queryByTestId("diff-viewer")).toBeNull();
  });

  it("adds references to the PR's commits from selected lines", async () => {
    stubMatchMedia((query) => query === DESKTOP_QUERY);
    await renderGuide({ guide: () => [200, readyGuide()] });
    await screen.findByRole("heading", { name: /Core change/ });
    const [card] = within(sections()[1] as HTMLElement).getAllByTestId("diff-file");
    await tap(card as HTMLElement, "new", 11);
    expect(draftText()).toBe("@bbbbbbb:./src/a.ts:11 ");
    useDrafts.setState({ drafts: {} });
    await tap(card as HTMLElement, "old", 11);
    expect(draftText()).toBe("@aaaaaaa:./src/a.ts:11 ");
  });

  it("expands a card's unchanged lines on request, reading both versions only then", async () => {
    const { calls } = await renderGuide({ guide: () => [200, readyGuide()] });
    await screen.findByRole("heading", { name: /Core change/ });
    const [whole, added] = within(sections()[0] as HTMLElement).getAllByTestId("diff-file") as [
      HTMLElement,
      HTMLElement,
    ];
    const [part] = within(sections()[1] as HTMLElement).getAllByTestId("diff-file") as [
      HTMLElement,
    ];
    await loadedDiff(whole);
    expect(contentCalls(calls)).toEqual([]);
    expect(within(whole).queryByTitle(/Expand/)).toBeNull();

    const user = userEvent.setup();
    await user.click(within(whole).getByRole("button", { name: "Expand unchanged lines" }));
    await within(whole).findAllByTitle(/Expand/, {}, { timeout: 3000 });
    expect(contentCalls(calls)).toEqual([
      { path: "src/a.ts", rev: PR.baseSha },
      { path: "src/a.ts", rev: PR.headSha },
    ]);
    expect(within(whole).queryByRole("button", { name: "Expand unchanged lines" })).toBeNull();
    expect(whole).not.toHaveTextContent("line 6");
    expect(whole).not.toHaveTextContent("line 13");
    await user.click(within(whole).getByTitle("Expand Down"));
    await waitFor(() => expect(whole).toHaveTextContent("line 13"));
    await user.click(within(whole).getByTitle("Expand All"));
    await waitFor(() => expect(whole).toHaveTextContent("line 6"));

    // An added file is its own single hunk; a card with some of its file's hunks doesn't expand,
    // since the rest of the file would show the other hunks' lines as unchanged.
    await loadedDiff(added);
    await loadedDiff(part);
    for (const card of [added, part]) {
      expect(within(card).queryByRole("button", { name: "Expand unchanged lines" })).toBeNull();
      expect(within(card).queryByTitle(/Expand/)).toBeNull();
    }
  });

  it("reads a renamed file's base under its old path and its head under the new one", async () => {
    const header =
      "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 80%\nrename from src/old.ts\nrename to src/new.ts\nindex 1..2 100644\n--- a/src/old.ts\n+++ b/src/new.ts\n";
    const unit = (hunk: string): PrGuideUnit => ({
      path: "src/new.ts",
      oldPath: "src/old.ts",
      status: "renamed",
      additions: 2,
      deletions: 2,
      patch: header + hunk,
    });
    const units = {
      "src/new.ts#1": unit("@@ -1,3 +1,3 @@\n line 1\n-line 2\n+LINE 2\n line 3\n"),
      "src/new.ts#2": unit("@@ -10,3 +10,3 @@\n line 10\n-line 11\n+LINE 11\n line 12\n"),
    };
    const guide = readyGuide({ units });
    const { calls } = await renderGuide({
      guide: () => [
        200,
        {
          ...guide,
          guide: {
            ...guide.guide,
            sections: [{ title: "Move", explanation: "", hunks: Object.keys(units) }],
            other: [],
          },
        },
      ],
    });
    await screen.findByRole("heading", { name: /Move/ });
    const card = screen.getByTestId("diff-file");
    await userEvent
      .setup()
      .click(within(card).getByRole("button", { name: "Expand unchanged lines" }));
    await within(card).findAllByTitle(/Expand/, {}, { timeout: 3000 });
    expect(contentCalls(calls)).toEqual([
      { path: "src/old.ts", rev: PR.baseSha },
      { path: "src/new.ts", rev: PR.headSha },
    ]);
  });

  it("doesn't offer expansion for a diff held back as large", async () => {
    const lines = Array.from({ length: LARGE_DIFF_LINES }, (_, i) => ` line ${i + 2}`).join("\n");
    const units: Record<string, PrGuideUnit> = {
      "big.ts#1": {
        path: "big.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: `diff --git a/big.ts b/big.ts\nindex 1..2 100644\n--- a/big.ts\n+++ b/big.ts\n@@ -1,${LARGE_DIFF_LINES + 1} +1,${LARGE_DIFF_LINES + 1} @@\n-line 1\n+LINE 1\n${lines}\n`,
      },
    };
    const guide = readyGuide({ units });
    await renderGuide({
      guide: () => [
        200,
        {
          ...guide,
          guide: {
            ...guide.guide,
            sections: [{ title: "Big", explanation: "", hunks: ["big.ts#1"] }],
            other: [],
          },
        },
      ],
    });
    await screen.findByRole("heading", { name: /Big/ });
    const card = screen.getByTestId("diff-file");
    expect(within(card).getByTestId("diff-too-large")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Expand unchanged lines" })).toBeNull();
  });

  it("shows a failed request with a retry", async () => {
    let fail = true;
    await renderGuide({
      guide: () =>
        fail
          ? [400, { error: { code: "invalid_body", message: "not attached" } }]
          : [200, { key: GUIDE_KEY, state: "generating" }],
    });
    expect(await screen.findByText("Couldn't load the guide: not attached")).toBeInTheDocument();
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Writing the review guide…")).toBeInTheDocument();
  });
});
