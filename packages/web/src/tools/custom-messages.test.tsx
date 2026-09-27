import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CustomMessageView } from "@/features/conversation/transcript/custom-message";
import "./index";

const text = (t: string) => [{ type: "text" as const, text: t }];

describe("custom message cards", () => {
  it("web-search-content-ready and web-search-error", () => {
    const { rerender } = render(
      <CustomMessageView
        customType="web-search-content-ready"
        content="Content fetched for 2/2 URLs [f1]. Full page content now available."
      />,
    );
    expect(screen.getByTestId("custom-message")).toHaveAttribute(
      "data-custom-type",
      "web-search-content-ready",
    );
    expect(screen.getByText(/Content fetched for 2\/2 URLs/)).toBeInTheDocument();
    rerender(
      <CustomMessageView customType="web-search-error" content="Content fetch failed [f1]: boom" />,
    );
    expect(
      screen.getByText("Content fetch failed [f1]: boom").closest(".text-destructive"),
    ).not.toBeNull();
  });

  it("web-search-results: title from details, results behind a toggle", async () => {
    render(
      <CustomMessageView
        customType="web-search-results"
        content={text("## Results\n\nSome result")}
        details={{ queries: ["node lts"], totalResults: 4 }}
      />,
    );
    expect(screen.getByText('Search results for "node lts" · 4 sources')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByText("Show results"));
    expect(await screen.findByText("Some result")).toBeInTheDocument();
  });

  it("curator-config and google-account", () => {
    const { rerender } = render(
      <CustomMessageView
        customType="curator-config"
        content={text("Curator disabled — web_search will return raw results")}
        details={{ workflow: "none" }}
      />,
    );
    expect(screen.getByText(/Curator disabled/)).toBeInTheDocument();
    rerender(
      <CustomMessageView
        customType="google-account"
        content={text("Active Google account: me@example.com")}
        details={{ available: true, email: "me@example.com" }}
      />,
    );
    expect(screen.getByText("Active Google account: me@example.com")).toBeInTheDocument();
  });

  it("mcp-ui-prompt / intent / context", () => {
    const { rerender } = render(
      <CustomMessageView
        customType="mcp-ui-prompt"
        content={text('User sent prompt from figma UI: "make it blue"')}
        details={{ server: "figma", tool: "open_app", prompt: "make it blue" }}
      />,
    );
    expect(screen.getByText("make it blue")).toBeInTheDocument();
    expect(screen.getByText("· figma · open_app")).toBeInTheDocument();
    rerender(
      <CustomMessageView
        customType="mcp-ui-intent"
        content={text("User triggered intent from figma UI: select")}
        details={{ server: "figma", tool: "open_app", intent: "select", params: { id: 3 } }}
      />,
    );
    expect(screen.getByText('select {"id":3}')).toBeInTheDocument();
    rerender(
      <CustomMessageView
        customType="mcp-ui-context"
        content={text("User submitted model context from figma UI:\nselection: 2 nodes")}
        details={{ server: "figma" }}
      />,
    );
    expect(screen.getByText(/UI context submitted/)).toBeInTheDocument();
  });

  it("unknown types fall back to generic markdown", async () => {
    render(<CustomMessageView customType="my-ext" content="**hello** there" />);
    expect(screen.getByText("my-ext")).toBeInTheDocument();
    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(screen.getByTestId("custom-message")).not.toHaveAttribute("data-custom-type");
  });
});
