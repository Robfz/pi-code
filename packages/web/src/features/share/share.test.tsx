import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { useConversationUi } from "@/features/conversation/conversation-ui";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";
import { makeAgent, makeSnapshot } from "@/test/fixtures";
import { type FetchCall, stubFetch } from "@/test/render";
import { composeShareText, parseShareParams } from "./share-text";

describe("composeShareText", () => {
  it("joins title, text and url as paragraphs", () => {
    expect(composeShareText({ title: "Title", text: "Some text", url: "https://ex.com/a" })).toBe(
      "Title\n\nSome text\n\nhttps://ex.com/a",
    );
  });

  it("drops the url when the text already has it", () => {
    expect(
      composeShareText({
        title: "Article",
        text: "Read https://ex.com/a",
        url: "https://ex.com/a",
      }),
    ).toBe("Article\n\nRead https://ex.com/a");
  });

  it("drops a title repeated in the text, or equal to the url", () => {
    expect(composeShareText({ title: "Hello world", text: "hello world — see this" })).toBe(
      "hello world — see this",
    );
    expect(composeShareText({ title: "https://ex.com", url: "https://ex.com" })).toBe(
      "https://ex.com",
    );
  });

  it("drops text contained in the title", () => {
    expect(composeShareText({ title: "Big news: launch", text: "launch" })).toBe(
      "Big news: launch",
    );
  });

  it("handles a lone field or nothing", () => {
    expect(composeShareText({ url: " https://ex.com " })).toBe("https://ex.com");
    expect(composeShareText({})).toBe("");
  });

  it("parses the raw query string", () => {
    expect(parseShareParams("?title=123&text=%7B%22a%22%3A1%7D&url=")).toEqual({
      title: "123",
      text: '{"a":1}',
    });
  });
});

class NoopEventSource {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  constructor(readonly url: string) {}
  close() {}
}

const SHARED =
  "/share?title=Great%20article&text=Check%20this%20https%3A%2F%2Fex.com%2Fa&url=https%3A%2F%2Fex.com%2Fa";
const EXPECTED = "Great article\n\nCheck this https://ex.com/a";

function stubApi(extra: (call: FetchCall) => [number, unknown] | undefined = () => undefined) {
  return stubFetch((call) => {
    const result = extra(call);
    if (result) return result;
    if (call.url === "/api/agents" && call.method === "GET") {
      return [200, { agents: [makeAgent({ id: "a1", cwd: "/home/me/alpha" })] }];
    }
    if (call.url === "/api/sessions") {
      return [
        200,
        {
          sessions: [
            {
              file: "/s/old.jsonl",
              id: "s-old",
              cwd: "/home/me/beta",
              name: "Old work",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
            {
              file: "/s/open.jsonl",
              id: "s-open",
              cwd: "/home/me/alpha",
              name: "Already open",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
              ownedBy: "a1",
            },
          ],
        },
      ];
    }
    if (call.url === "/api/projects") return [200, { projects: [] }];
    if (call.url === "/api/fs/dirs") return [200, { dirs: [] }];
    const snapshot = /^\/api\/agents\/([^/]+)\/snapshot$/.exec(call.url);
    if (snapshot?.[1]) {
      return [200, makeSnapshot({ agent: makeAgent({ id: snapshot[1], cwd: "/home/me/x" }) })];
    }
    return undefined;
  });
}

function renderAt(path: string) {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
  useConversationUi.getState().reset();
});

describe("Share target", () => {
  it("prefills the composer of an open agent", async () => {
    vi.stubGlobal("EventSource", NoopEventSource);
    stubApi();
    const router = renderAt(SHARED);
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Send to…" })).toBeInTheDocument();
    expect(screen.getByLabelText("Shared text")).toHaveValue(EXPECTED);
    // Open sessions appear once, as open conversations.
    expect(await screen.findByText("Old work")).toBeInTheDocument();
    expect(screen.queryByText("Already open")).toBeNull();

    await user.click(await screen.findByRole("button", { name: /alpha/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1"));
    expect(await screen.findByRole("textbox", { name: "Message" })).toHaveValue(EXPECTED);
  });

  it("uses the edited text", async () => {
    vi.stubGlobal("EventSource", NoopEventSource);
    stubApi();
    renderAt(SHARED);
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Shared text");
    await user.clear(field);
    await user.type(field, "Summarize this");
    await user.click(await screen.findByRole("button", { name: /alpha/ }));
    expect(await screen.findByRole("textbox", { name: "Message" })).toHaveValue("Summarize this");
  });

  it("resumes a recent session with the draft", async () => {
    vi.stubGlobal("EventSource", NoopEventSource);
    const { calls } = stubApi((call) =>
      call.url === "/api/agents" && call.method === "POST"
        ? [200, { agent: makeAgent({ id: "b2", cwd: "/home/me/beta" }) }]
        : undefined,
    );
    const router = renderAt(SHARED);
    const user = userEvent.setup();
    await user.click(await screen.findByText("Old work"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/b2"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ sessionFile: "/s/old.jsonl" });
    expect(await screen.findByRole("textbox", { name: "Message" })).toHaveValue(EXPECTED);
  });

  it("starts a new conversation in a folder with the draft", async () => {
    vi.stubGlobal("EventSource", NoopEventSource);
    const { calls } = stubApi((call) =>
      call.url === "/api/agents" && call.method === "POST"
        ? [201, { agent: makeAgent({ id: "n3", cwd: "/home/me/gamma" }) }]
        : undefined,
    );
    const router = renderAt(SHARED);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /New conversation in/ }));
    await user.type(await screen.findByLabelText("Folder path"), "/home/me/gamma");
    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/n3"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ cwd: "/home/me/gamma" });
    expect(await screen.findByRole("textbox", { name: "Message" })).toHaveValue(EXPECTED);
  });

  it("keeps numeric and JSON-looking values as text", async () => {
    stubApi();
    renderAt("/share?text=12345");
    expect(await screen.findByLabelText("Shared text")).toHaveValue("12345");
  });
});
