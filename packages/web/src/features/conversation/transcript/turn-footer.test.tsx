import {
  initialLiveState,
  type LiveState,
  type SessionEntry,
  type Transcript,
} from "@pi-code/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewStore } from "@/features/review/review-state";
import { copyText } from "@/lib/clipboard";
import { DESKTOP_QUERY } from "@/lib/use-media-query";
import { type Density, useUiPrefs } from "@/store/ui-prefs";
import { stubMatchMedia } from "@/test/dom-stubs";
import { hydratedStore, renderWithStore } from "@/test/render";
import { Transcript as TranscriptView } from "./transcript";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));

/** A transcript from messages chained in order. */
function chain(messages: unknown[]): Transcript {
  const entries = messages.map((message, i) => ({
    type: "message",
    id: `e${i}`,
    parentId: i === 0 ? null : `e${i - 1}`,
    timestamp: new Date(0).toISOString(),
    message,
  })) as SessionEntry[];
  return { entries, leafId: entries.at(-1)?.id ?? null };
}

const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
const assistant = (content: unknown[], patch: Record<string, unknown>) => ({
  role: "assistant",
  content,
  stopReason: "stop",
  ...patch,
});
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, args: unknown) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const result = (id: string, toolName: string, details?: unknown) => ({
  role: "toolResult",
  toolCallId: id,
  toolName,
  content: [{ type: "text", text: "ok" }],
  details,
  isError: false,
  timestamp: 0,
});
const cost = (total: number) => ({ usage: { cost: { total } } });

/** A turn that writes one file and edits another, then answers in two paragraphs. */
const WORKED = [
  user("go", 1_000),
  assistant(
    [
      call("w1", "write", { path: "src/new.txt", content: "1\n2\n3\n" }),
      call("e1", "edit", { path: "src/a.ts", edits: [] }),
    ],
    { stopReason: "toolUse", timestamp: 10_000, ...cost(0.1) },
  ),
  result("w1", "write"),
  result("e1", "edit", { patch: "@@ -1,2 +1,2 @@\n-a\n+b\n c\n" }),
  assistant([text("Done."), text("Both files changed.")], {
    timestamp: 61_000,
    durationMs: 4_000,
    ...cost(0.0234),
  }),
];

async function renderTranscript(
  messages: unknown[],
  { density = "balanced", live = {} }: { density?: Density; live?: Partial<LiveState> } = {},
) {
  useUiPrefs.setState({ density });
  const store = hydratedStore({
    transcript: chain(messages),
    live: { ...initialLiveState(), ...live },
  });
  const rendered = await renderWithStore(<TranscriptView />, store);
  return { ...rendered, agentId: store.getState().agentId };
}

const footer = () => screen.getByTestId("turn-footer");
const footerText = () =>
  Array.from(footer().children)
    .map((el) => el.textContent)
    .join(" ")
    .trim();

beforeEach(() => {
  useUiPrefs.setState({ density: "balanced" });
  useReviewStore.setState({ reviews: {} });
  vi.mocked(copyText).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TurnFooter", () => {
  it("shows duration, cost and files under a finished turn", async () => {
    await renderTranscript(WORKED);
    expect(footerText()).toBe("1m 4s · $0.123 · 2 files+4−1");
    const chip = screen.getByTestId("turn-files");
    expect(within(chip).getByText("+4")).toHaveClass("text-diff-add");
    expect(within(chip).getByText("−1")).toHaveClass("text-diff-del");
    expect(footer()).toHaveClass("text-xs", "text-faint-foreground");
  });

  it("leaves the duration out in Compact", async () => {
    await renderTranscript(WORKED, { density: "compact" });
    expect(footerText()).toBe("$0.123 · 2 files+4−1");
  });

  it("formats seconds, the cost above a dollar and a single file", async () => {
    await renderTranscript([
      user("go", 0),
      assistant([call("w1", "write", { path: "a.txt", content: "x" })], {
        stopReason: "toolUse",
        timestamp: 1_000,
        ...cost(1),
      }),
      result("w1", "write"),
      assistant([text("ok")], { timestamp: 11_000, durationMs: 1_400, ...cost(0.5) }),
    ]);
    expect(footerText()).toBe("12s · $1.50 · 1 file+1−0");
  });

  it("has no files chip without edits or writes, and no duration without a user message", async () => {
    await renderTranscript([assistant([text("Hello")], { timestamp: 5_000, ...cost(0.01) })]);
    expect(footerText()).toBe("$0.010");
    expect(screen.queryByTestId("turn-files")).toBeNull();
  });

  it("only under finished turns with an assistant message", async () => {
    // A leading turn of markers, then a finished turn and a live one.
    const markers = { type: "model_change", provider: "x", modelId: "y" };
    const transcript = chain([...WORKED, user("again", 70_000)]);
    const entries: SessionEntry[] = [
      {
        ...markers,
        id: "m0",
        parentId: null,
        timestamp: new Date(0).toISOString(),
      } as unknown as SessionEntry,
      ...transcript.entries.map((e, i) => (i === 0 ? { ...e, parentId: "m0" } : e)),
    ];
    useUiPrefs.setState({ density: "balanced" });
    await renderWithStore(
      <TranscriptView />,
      hydratedStore({
        transcript: { entries, leafId: transcript.leafId },
        live: { ...initialLiveState(), run: { active: true } },
      }),
    );
    const turns = screen.getAllByTestId(/^(live-)?turn$/);
    expect(turns.map((t) => within(t).queryByTestId("turn-footer") !== null)).toEqual([
      false,
      true,
      false,
    ]);
    expect(turns.at(-1)).toHaveAttribute("data-testid", "live-turn");
  });

  it("not under a pending user message", async () => {
    await renderTranscript(WORKED, {
      live: { pendingUser: { role: "user", content: "next", timestamp: 80_000 } },
    });
    expect(screen.getAllByTestId("turn-footer")).toHaveLength(1);
    const pending = screen.getAllByTestId(/^(live-)?turn$/).at(-1) as HTMLElement;
    expect(within(pending).queryByTestId("turn-footer")).toBeNull();
  });

  it("the chip opens the review pane's Changes tab on desktop", async () => {
    stubMatchMedia((query) => query === DESKTOP_QUERY);
    const { agentId, router } = await renderTranscript(WORKED);
    useReviewStore.getState().setTab(agentId, "files");
    await userEvent.setup().click(screen.getByTestId("turn-files"));
    expect(useReviewStore.getState().reviews[agentId]).toMatchObject({
      paneOpen: true,
      tab: "changes",
    });
    expect(router.state.location.pathname).toBe("/");
  });

  it("the chip navigates to the diff page on phone", async () => {
    stubMatchMedia(() => false);
    const { agentId, router } = await renderTranscript(WORKED);
    await userEvent.setup().click(screen.getByTestId("turn-files"));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(`/agents/${agentId}/diff`));
    expect(useReviewStore.getState().reviews[agentId]).toMatchObject({
      paneOpen: false,
      tab: "changes",
    });
  });

  it("Copy writes the final text as markdown", async () => {
    await renderTranscript(WORKED);
    await userEvent.setup().click(screen.getByRole("button", { name: "Copy response" }));
    expect(copyText).toHaveBeenCalledWith("Done.\n\nBoth files changed.");
  });

  it("no Copy without final text", async () => {
    await renderTranscript([
      user("go", 0),
      assistant([text("Reading."), call("r1", "read", { path: "a.ts" })], {
        stopReason: "toolUse",
        timestamp: 1_000,
        ...cost(0.01),
      }),
      result("r1", "read"),
    ]);
    expect(screen.getByTestId("turn-footer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy response" })).toBeNull();
  });
});
