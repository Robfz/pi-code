import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { imagePolicy, Markdown } from "./markdown";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("Markdown", () => {
  it("keeps single newlines inside a paragraph as line breaks (like pi's TUI)", () => {
    const { container } = render(<Markdown text={"1\n2\n3"} />);
    const root = container.querySelector(".markdown");
    expect(root?.className).toContain("[&_p]:whitespace-pre-line");
    const p = container.querySelector("p");
    expect(p?.textContent).toBe("1\n2\n3");
  });

  it("doesn't load remote images until tapped", async () => {
    const { container } = render(
      <Markdown text={"See ![a chart](https://tracker.example/pixel.png?u=1) here"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    const placeholder = screen.getByTestId("markdown-image-placeholder");
    expect(placeholder).toHaveTextContent("a chart");
    expect(placeholder).toHaveTextContent("tracker.example");
    await userEvent.setup().click(placeholder);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://tracker.example/pixel.png?u=1");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("never loads http: images; shows data: images inline", () => {
    const { container } = render(
      <Markdown text={`![plain](http://insecure.example/x.png)\n\n![inline](${PIXEL})`} />,
    );
    expect(screen.getByTestId("markdown-image-blocked")).toHaveTextContent("plain");
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([PIXEL]);
  });

  it("raw HTML can't load resources", () => {
    const { container } = render(
      <Markdown
        text={[
          '<img src="https://evil.example/a.png" alt="raw">',
          "",
          '<picture><source srcset="https://evil.example/b.png"><img src="https://evil.example/c.png"></picture>',
          "",
          '<iframe src="https://evil.example/frame"></iframe>',
          "",
          '<video poster="https://evil.example/p.png" src="https://evil.example/v.mp4"></video>',
          "",
          '<div style="background:url(https://evil.example/bg.png)">styled</div>',
        ].join("\n")}
      />,
    );
    const html = container.innerHTML;
    expect(container.querySelector("img, source, iframe, video, audio, object, embed")).toBeNull();
    expect(html).not.toMatch(/srcset|style="background/i);
    expect(screen.getAllByTestId("markdown-image-placeholder").length).toBeGreaterThan(0);
  });
});

describe("Markdown codeRefs", () => {
  const TEXT = [
    "See @src/a.ts:3, `@b.ts:4-5`, *@c.ts:6* and [@d.ts:7](https://x.example).",
    "",
    "```",
    "@e.ts:8",
    "```",
  ].join("\n");
  const refs = (root: HTMLElement) =>
    Array.from(root.querySelectorAll("[data-code-ref]")).map((ref) => ref.textContent);

  it("marks references in text, inline code and emphasis, not in links or code blocks", () => {
    const { container } = render(<Markdown text={TEXT} codeRefs />);
    expect(refs(container)).toEqual(["@src/a.ts:3", "@b.ts:4-5", "@c.ts:6"]);
    const inline = container.querySelector("code [data-code-ref]");
    expect(inline).toHaveAttribute("role", "button");
    expect(inline).toHaveAttribute("tabindex", "0");
    expect(container).toHaveTextContent("@d.ts:7");
    expect(container).toHaveTextContent("@e.ts:8");
  });

  it("shows references as text-link chips", () => {
    const { container } = render(<Markdown text={TEXT} codeRefs />);
    const plain = container.querySelector("[data-code-ref]");
    expect(plain).toHaveTextContent("@src/a.ts:3");
    expect(plain).toHaveClass("text-link", "bg-link/12", "font-mono", "rounded-[5px]");
  });

  it("marks nothing without the prop", () => {
    const { container } = render(<Markdown text={TEXT} />);
    expect(refs(container)).toEqual([]);
  });
});

describe("imagePolicy", () => {
  it("classifies image URLs", () => {
    expect(imagePolicy("https://x.example/a.png")).toEqual({ kind: "click", host: "x.example" });
    expect(imagePolicy(PIXEL)).toEqual({ kind: "inline" });
    expect(imagePolicy("http://x.example/a.png").kind).toBe("blocked");
    expect(imagePolicy("javascript:alert(1)").kind).toBe("blocked");
    expect(imagePolicy("data:text/html,<b>x</b>").kind).toBe("blocked");
    expect(imagePolicy("relative/a.png").kind).toBe("blocked");
    expect(imagePolicy(undefined).kind).toBe("blocked");
  });
});

describe("Markdown styles", () => {
  it("renders prose at text-prose, replaced by a caller's size", () => {
    const { container, rerender } = render(<Markdown text="hello" />);
    expect(container.querySelector(".markdown")).toHaveClass("text-prose");
    rerender(<Markdown text="hello" className="text-xs" />);
    expect(container.querySelector(".markdown")).toHaveClass("text-xs");
    expect(container.querySelector(".markdown")).not.toHaveClass("text-prose");
  });

  it("gives links text-link", () => {
    render(<Markdown text="See [the docs](https://x.example/docs)." />);
    const link = screen.getByText("the docs");
    expect(link).toHaveAttribute("data-streamdown", "link");
    expect(link).toHaveClass("text-link", "hover:underline", "no-underline");
    expect(link).not.toHaveClass("text-primary");
  });

  it("heads code blocks with their language and a copy button, no download", () => {
    const { container } = render(<Markdown text={"```ts\nconst a = 1;\n```"} />);
    const block = container.querySelector('[data-streamdown="code-block"]') as HTMLElement;
    expect(block).not.toBeNull();
    expect(
      within(block).getByText("ts", { selector: '[data-streamdown="code-block-header"] *' }),
    ).toBeInTheDocument();
    expect(within(block).getByRole("button", { name: "Copy Code" })).toBeInTheDocument();
    expect(within(block).queryByRole("button", { name: /download/i })).toBeNull();
    expect(within(block).getAllByRole("button")).toHaveLength(1);
  });
});

describe("code highlighting", () => {
  it("highlights fenced code in the palette's syntax colours once the plugin has loaded", async () => {
    const { container } = render(<Markdown text={"```ts\nconst answer: number = 42;\n```"} />);
    expect(container).toHaveTextContent("const answer: number = 42;");
    await waitFor(
      () =>
        expect(within(container).getByText("const")).toHaveStyle({
          "--sdm-c": "var(--syntax-keyword)",
          "--shiki-dark": "var(--syntax-keyword)",
        }),
      { timeout: 5_000 },
    );
    expect(container).toHaveTextContent("const answer: number = 42;");
  });
});
