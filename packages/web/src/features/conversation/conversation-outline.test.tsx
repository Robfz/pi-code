import {
  formatFileBlock,
  formatPrBlock,
  formatPrGuideBlock,
  initialLiveState,
  type SessionEntry,
} from "@pi-code/protocol";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { stubMatchMedia } from "@/test/dom-stubs";
import { hydratedStore, renderWithStore } from "@/test/render";
import { promptTitle } from "./conversation-outline";
import { ConversationScreen } from "./conversation-screen";

const message = (id: string, parentId: string | null, body: Record<string, unknown>) =>
  ({
    id,
    parentId,
    timestamp: new Date(0).toISOString(),
    type: "message",
    message: { timestamp: 0, ...body },
  }) as unknown as SessionEntry;

const user = (id: string, parentId: string | null, content: unknown) =>
  message(id, parentId, { role: "user", content });
const reply = (id: string, parentId: string) =>
  message(id, parentId, {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: `Reply ${id}` }],
  });

/** Three prompts with text and, between the first two, one with only an image. */
const ENTRIES = [
  user("u1", null, "Fix the login bug\nIt fails on Safari"),
  reply("a1", "u1"),
  user("u2", "a1", [{ type: "image", data: "AAAA", mimeType: "image/png" }]),
  reply("a2", "u2"),
  user("u3", "a2", "\n  Add tests  \n"),
  reply("a3", "u3"),
  user("u4", "a3", "Ship it"),
  reply("a4", "u4"),
];

/** Each prompt's top in the scroller's content, which is 3000px tall in a 600px viewport. */
const TOPS: Record<string, number> = { u1: 0, u2: 500, u3: 1000, u4: 2000 };

function render(entries = ENTRIES, live = initialLiveState()) {
  const store = hydratedStore({
    transcript: { entries, leafId: entries.at(-1)?.id ?? null },
    live,
  });
  return renderWithStore(<ConversationScreen />, store);
}

const outline = () => screen.getByRole("navigation", { name: "Conversation outline" });
const items = () => within(outline()).getAllByRole("button");
const current = () =>
  within(outline())
    .getAllByRole("button")
    .filter((item) => item.getAttribute("aria-current") === "true")
    .map((item) => item.textContent);

describe("promptTitle", () => {
  it("is the first non-blank line, trimmed, after attached files", () => {
    expect(promptTitle("Fix it\nnow")).toBe("Fix it");
    expect(promptTitle("\n\n  Then this  \n")).toBe("Then this");
    expect(promptTitle('<file name="a.ts">\nconst a = 1;\n</file>\nReview a.ts')).toBe(
      "Review a.ts",
    );
    expect(promptTitle([{ type: "image", data: "AAAA", mimeType: "image/png" }])).toBe("");
  });

  it("names a PR review prompt by its PR", () => {
    const pr = (update: boolean) =>
      formatPrBlock({
        number: 12,
        title: "Speed up",
        state: "open",
        url: "https://github.com/o/r/pull/12",
        update,
        text: "Pull request o/r#12\n…",
      });
    expect(promptTitle(`${pr(false)}Give me an overview`)).toBe("#12 Speed up");
    expect(promptTitle(`${pr(true)}Tell me what changed`)).toBe("#12 Speed up (updated)");
    const guide = formatPrGuideBlock({ number: 12, title: "Speed up", url: "u", text: "guide" });
    expect(promptTitle(`${guide}Use it as a map`)).toBe("Review guide · #12 Speed up");
  });

  it("skips an expanded skill, else names it", () => {
    const skill = '<skill name="review" location="/s/SKILL.md">\n# Review\nSteps\n</skill>';
    expect(promptTitle(`${skill}\n\nCheck the diff`)).toBe("Check the diff");
    expect(promptTitle(skill)).toBe("/skill:review");
  });

  it("skips an expanded skill's attached files", () => {
    const skill = '<skill name="review" location="/s/SKILL.md">\n# Review\n</skill>';
    const file = formatFileBlock({ name: "a.ts", text: "const a = 1;" });
    expect(promptTitle(`${skill}\n\n${file}Check a.ts`)).toBe("Check a.ts");
    expect(promptTitle(`${skill}\n\n${file.trimEnd()}`)).toBe("/skill:review");
  });
});

describe("ConversationOutline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("on desktop", () => {
    let resize: () => void;
    beforeEach(() => {
      stubMatchMedia((query) => query === DESKTOP_QUERY);
      const observers = new Set<() => void>();
      resize = () => {
        for (const notify of observers) notify();
      };
      vi.stubGlobal(
        "ResizeObserver",
        class {
          private readonly notify: () => void;
          constructor(callback: ResizeObserverCallback) {
            this.notify = () => callback([], this as unknown as ResizeObserver);
          }
          observe() {
            observers.add(this.notify);
          }
          disconnect() {
            observers.delete(this.notify);
          }
        },
      );
    });

    /** Lays the scroller out as in TOPS and scrolls it to `top`. */
    function layOut(top: number) {
      const scroller = screen.getByTestId("transcript-column").parentElement as HTMLElement;
      Object.defineProperties(scroller, {
        scrollTop: { value: top, writable: true, configurable: true },
        scrollHeight: { value: 3000, configurable: true },
        clientHeight: { value: 600, configurable: true },
      });
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
        this: Element,
      ) {
        const id = (this as HTMLElement).dataset.promptId;
        const y = this === scroller ? 0 : id ? (TOPS[id] ?? 0) - scroller.scrollTop : 0;
        const height = this === scroller ? 600 : 0;
        return { top: y, bottom: y + height, left: 0, right: 0, width: 0, height } as DOMRect;
      });
      return scroller;
    }

    function scrollTo(scroller: HTMLElement, top: number) {
      scroller.scrollTop = top;
      fireEvent.scroll(scroller);
    }

    it("lists the prompts with text in a container-queried margin", async () => {
      await render();
      expect(items().map((item) => item.textContent)).toEqual([
        "Fix the login bug",
        "Add tests",
        "Ship it",
      ]);
      expect(outline().parentElement).toHaveClass("hidden", "@min-[78rem]:block");
      expect(screen.getByTestId("transcript-column").parentElement).toHaveClass("@container-size");
    });

    it("lists a pending prompt last", async () => {
      await render(ENTRIES, {
        ...initialLiveState(),
        pendingUser: { role: "user", content: "One more thing", timestamp: 0 },
      });
      expect(items().map((item) => item.textContent)).toEqual([
        "Fix the login bug",
        "Add tests",
        "Ship it",
        "One more thing",
      ]);
    });

    it("is absent with fewer than two prompts with text", async () => {
      await render(ENTRIES.slice(0, 4));
      expect(screen.queryByRole("navigation", { name: "Conversation outline" })).toBeNull();
    });

    it("marks the last prompt above a third of the viewport, or in view at the end", async () => {
      await render();
      const scroller = layOut(0);
      scrollTo(scroller, 0);
      await waitFor(() => expect(current()).toEqual(["Fix the login bug"]));
      // u3 at 100px, above the line at 200px.
      scrollTo(scroller, 900);
      await waitFor(() => expect(current()).toEqual(["Add tests"]));
      // u4 at 300px: below the line.
      scrollTo(scroller, 1700);
      await waitFor(() => expect(current()).toEqual(["Add tests"]));
      // At the end, u4 at 500px is in view.
      scrollTo(scroller, 2400);
      await waitFor(() => expect(current()).toEqual(["Ship it"]));
    });

    it("measures again on resize, and not at all while hidden", async () => {
      await render();
      const scroller = layOut(2400);
      scrollTo(scroller, 2400);
      await waitFor(() => expect(current()).toEqual(["Ship it"]));

      // Hidden, as beside the open pane: a scroll measures nothing.
      let visible = false;
      Object.defineProperty(outline(), "checkVisibility", { value: () => visible });
      const measure = vi.mocked(Element.prototype.getBoundingClientRect);
      measure.mockClear();
      scrollTo(scroller, 900);
      await act(() => new Promise(requestAnimationFrame));
      expect(measure).not.toHaveBeenCalled();
      expect(current()).toEqual(["Ship it"]);

      // The pane closing widens the scroller: the resize brings the outline up to date.
      visible = true;
      act(() => resize());
      await waitFor(() => expect(current()).toEqual(["Add tests"]));
    });

    it("scrolls a clicked prompt near the top and stops following live like a scroll up", async () => {
      await render();
      const scroller = layOut(2400);
      const scroll = vi.spyOn(scroller, "scrollTo").mockImplementation(() => {});
      fireEvent.click(within(outline()).getByRole("button", { name: "Add tests" }));
      expect(scroll).toHaveBeenCalledWith({ top: 984, behavior: "smooth" });
      // Content growing before the smooth scroll's first scroll event doesn't pin it back.
      act(() => resize());
      expect(scroller.scrollTop).toBe(2400);
    });
  });

  it("isn't rendered on phone", async () => {
    stubMatchMedia(() => false);
    await render();
    expect(screen.getByTestId("transcript")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Conversation outline" })).toBeNull();
  });
});
