import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CuratorButton, ExternalLink, isWebUrl } from "./common";

// Built at runtime so the linter doesn't take the test input for a real `javascript:` URL.
const EVIL = ["javascript", "alert(1)"].join(":");

describe("links from tool / extension data", () => {
  it("only http(s) URLs become links, opened with noopener noreferrer", () => {
    render(
      <>
        <ExternalLink href="https://example.com/a">good</ExternalLink>
        <ExternalLink href={EVIL}>evil</ExternalLink>
        <ExternalLink href="data:text/html,<b>x</b>">data</ExternalLink>
        <ExternalLink href="/api/agents/a1">relative</ExternalLink>
      </>,
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://example.com/a");
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("evil").closest("a")).toBeNull();
    expect(screen.getByText("data").closest("a")).toBeNull();
    expect(screen.getByText("relative").closest("a")).toBeNull();
  });

  it("the curator button needs an http(s) URL", () => {
    const { rerender } = render(<CuratorButton url={EVIL} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Curator: javascript:alert\(1\)/)).toBeInTheDocument();
    rerender(<CuratorButton url="http://host:8443/?session=x" />);
    expect(screen.getByRole("link", { name: /Review in curator/ })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
  });

  it("isWebUrl", () => {
    expect(isWebUrl("HTTPS://x.example")).toBe(true);
    expect(isWebUrl("http://x")).toBe(true);
    expect(isWebUrl("ftp://x")).toBe(false);
    expect(isWebUrl(" https://x")).toBe(false);
    expect(isWebUrl(undefined)).toBe(false);
  });
});
