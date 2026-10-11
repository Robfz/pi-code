import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fixtureToolCall, propsAt, rowBody, rowParts } from "./testing";
import { ToolCallView } from "./tool-call-view";
import { sourcesFromText } from "./web-access";

const row = () => screen.getByTestId("tool-call");
const header = () => row().firstElementChild as HTMLElement;
const expand = () => userEvent.setup().click(header());
const label = () => rowParts(row());

describe("web_search (web-search fixture)", () => {
  const call = fixtureToolCall("web-search", "web_search");

  it("running: query, collapsed, progress text in the body", async () => {
    render(<ToolCallView {...propsAt(call, { update: 0 })} />);
    expect(label()).toMatchObject({
      icon: "globe",
      verb: "Searching web",
      shimmer: true,
      target: '"Node.js current LTS codename"',
      meta: undefined,
    });
    expect(header()).toHaveAttribute("aria-expanded", "false");
    await expand();
    expect(
      screen.getByText('Searching "Node.js current LTS codename" (0/1 complete)...'),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Review in curator/ })).toBeNull();
  });

  it("offers 'Review in curator' when a curator URL exists for the call", () => {
    render(
      <ToolCallView
        {...propsAt(call, { update: 1 })}
        curatorUrl="https://host.ts.net:8443/curator/?session=abc"
      />,
    );
    const link = screen.getByRole("link", { name: /Review in curator/ });
    expect(link).toHaveAttribute("href", "https://host.ts.net:8443/curator/?session=abc");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("keeps 'Review in curator' reachable when the call is collapsed", async () => {
    render(
      <ToolCallView
        {...propsAt(call, { update: 1 })}
        curatorUrl="https://host.ts.net:8443/?session=abc"
      />,
    );
    expect(header()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("link", { name: /Review in curator/ })).toHaveAttribute(
      "href",
      "https://host.ts.net:8443/?session=abc",
    );
    await expand(); // the body shows it instead
    expect(screen.getAllByRole("link", { name: /Review in curator/ })).toHaveLength(1);
  });

  it("done: result count, then source links and full results when expanded", async () => {
    render(<ToolCallView {...propsAt(call, "end")} />);
    expect(label()).toMatchObject({
      verb: "Searched web",
      shimmer: false,
      target: '"Node.js current LTS codename"',
      meta: "· 5 sources",
    });
    await expand();
    const list = screen.getByTestId("source-list");
    const links = within(list).getAllByRole("link");
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links[0]).toHaveAttribute(
      "href",
      "https://github.com/nodejs/release/blob/main/README.md",
    );
    expect(links[0]).toHaveTextContent("README.md at main · nodejs/Release");
    expect(screen.getByText("Full results")).toBeInTheDocument();
  });

  it("summary and curated queries", async () => {
    render(
      <ToolCallView
        toolCallId="s1"
        toolName="web_search"
        args={{ queries: ["a", "b"] }}
        status="done"
        isError={false}
        result={{
          content: [{ type: "text", text: "summary text" }],
          details: {
            queryCount: 2,
            successfulQueries: 2,
            totalResults: 3,
            summary: { text: "Krypton is the **Active LTS**.", workflow: "summary-review" },
            curated: true,
            curatedQueries: [
              {
                query: "a",
                provider: "exa",
                answer: "x",
                sources: [{ title: "Doc", url: "https://d.example/x" }],
                error: null,
              },
              { query: "b", provider: "exa", answer: null, sources: [], error: "rate limited" },
            ],
          },
        }}
      />,
    );
    expect(label()).toMatchObject({ target: "2 queries", meta: "· 3 sources" });
    await expand();
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(await screen.findByText("Active LTS")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Doc" })).toHaveAttribute(
      "href",
      "https://d.example/x",
    );
    expect(screen.getByText("rate limited")).toBeInTheDocument();
  });

  it("failed call", () => {
    render(
      <ToolCallView
        toolCallId="s3"
        toolName="web_search"
        args={{ query: "x" }}
        status="error"
        isError
        result={{ content: [{ type: "text", text: "No search provider configured" }] }}
      />,
    );
    expect(label()).toMatchObject({
      icon: "circle-alert",
      verb: "Web search failed",
      target: '"x"',
      meta: "No search provider configured",
    });
  });

  it("error", async () => {
    render(
      <ToolCallView
        toolCallId="s2"
        toolName="web_search"
        args={{ query: "x" }}
        status="done"
        isError={false}
        result={{
          content: [{ type: "text", text: "Search curation cancelled (user)." }],
          details: { error: "Search curation cancelled (user).", cancelled: true },
        }}
      />,
    );
    await expand();
    expect(screen.getByText("Search curation cancelled (user).")).toHaveClass("text-destructive");
  });

  it("sourcesFromText", () => {
    expect(
      sourcesFromText("a\nSource: T (https://x.dev/a_(b))\nSource: T (https://x.dev/a_(b))\n"),
    ).toEqual([{ title: "T", url: "https://x.dev/a_(b)" }]);
  });
});

describe("source_check", () => {
  it("claim, source count, artifact sources", async () => {
    const { rerender } = render(
      <ToolCallView
        toolCallId="sc"
        toolName="source_check"
        args={{ claim: "Node 24 is Krypton" }}
        status="running"
        isError={false}
      />,
    );
    expect(label()).toMatchObject({
      icon: "globe",
      verb: "Checking",
      shimmer: true,
      target: "Node 24 is Krypton",
    });
    rerender(
      <ToolCallView
        toolCallId="sc"
        toolName="source_check"
        args={{ claim: "Node 24 is Krypton" }}
        status="error"
        isError
        result={{ content: [{ type: "text", text: "boom" }] }}
      />,
    );
    expect(label()).toMatchObject({ verb: "Check failed", meta: "boom" });
    rerender(
      <ToolCallView
        toolCallId="sc"
        toolName="source_check"
        args={{ claim: "Node 24 is Krypton" }}
        status="done"
        isError={false}
        result={{
          content: [{ type: "text", text: "# Research artifact" }],
          details: {
            responseId: "r1",
            sourceCount: 1,
            passageCount: 2,
            artifact: {
              id: "r1",
              sources: [
                {
                  rank: 1,
                  url: "https://nodejs.org/en/about/previous-releases",
                  title: "Node.js releases",
                  quality: "official",
                },
              ],
              passages: [],
            },
          },
        }}
      />,
    );
    expect(label()).toMatchObject({
      verb: "Checked",
      target: "Node 24 is Krypton",
      meta: "· 1 source",
    });
    await expand();
    expect(screen.getByRole("link", { name: "Node.js releases" })).toBeInTheDocument();
    expect(screen.getByText("2 passages extracted")).toBeInTheDocument();
  });
});

describe("fetch_content / get_search_content", () => {
  it("fetch_content: URL, title and markdown content", async () => {
    const { rerender } = render(
      <ToolCallView
        toolCallId="f"
        toolName="fetch_content"
        args={{ url: "https://example.com/post" }}
        status="running"
        isError={false}
      />,
    );
    expect(label()).toMatchObject({
      icon: "link",
      verb: "Fetching",
      shimmer: true,
      target: "https://example.com/post",
    });
    rerender(
      <ToolCallView
        toolCallId="f"
        toolName="fetch_content"
        args={{ url: "https://example.com/post" }}
        status="done"
        isError={false}
        result={{
          content: [{ type: "text", text: "# Hello\n\nSome **content**." }],
          details: {
            urls: ["https://example.com/post"],
            urlCount: 1,
            successful: 1,
            title: "Example post",
          },
        }}
      />,
    );
    expect(label()).toMatchObject({ verb: "Fetched", target: "Example post", meta: undefined });
    await expand();
    expect(screen.getByRole("link", { name: "https://example.com/post" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeInTheDocument();
  });

  it("fetch_content: several URLs, error", async () => {
    render(
      <ToolCallView
        toolCallId="f2"
        toolName="fetch_content"
        args={{ urls: ["https://a.dev", "https://b.dev"] }}
        status="error"
        isError
        result={{
          content: [{ type: "text", text: "Error: all fetches failed" }],
          details: { error: "all fetches failed" },
        }}
      />,
    );
    expect(label()).toMatchObject({
      icon: "circle-alert",
      verb: "Fetch failed",
      target: "2 URLs",
      meta: "Error: all fetches failed",
    });
    await expand();
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(within(rowBody(row())).getByText("Error: all fetches failed")).toHaveClass(
      "text-destructive",
    );
  });

  it("get_search_content: stored URL content", async () => {
    const { rerender } = render(
      <ToolCallView
        toolCallId="g"
        toolName="get_search_content"
        args={{ responseId: "abc123", urlIndex: 0 }}
        status="running"
        isError={false}
      />,
    );
    expect(label()).toMatchObject({
      icon: "globe",
      verb: "Getting content",
      shimmer: true,
      target: "URL #0",
    });
    rerender(
      <ToolCallView
        toolCallId="g"
        toolName="get_search_content"
        args={{ responseId: "abc123", urlIndex: 0 }}
        status="error"
        isError
        result={{ content: [{ type: "text", text: "Not found" }] }}
      />,
    );
    expect(label()).toMatchObject({ verb: "Get content failed", target: "URL #0" });
    rerender(
      <ToolCallView
        toolCallId="g"
        toolName="get_search_content"
        args={{ responseId: "abc123", urlIndex: 0 }}
        status="done"
        isError={false}
        result={{
          content: [{ type: "text", text: "Stored page body" }],
          details: { url: "https://example.com/doc", title: "Doc page", contentLength: 16 },
        }}
      />,
    );
    expect(label()).toMatchObject({ verb: "Got content", target: "Doc page" });
    await expand();
    expect(screen.getByRole("link", { name: "https://example.com/doc" })).toBeInTheDocument();
    expect(await screen.findByText("Stored page body")).toBeInTheDocument();
  });
});
