import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { lazyCodePlugin, PLAIN_THEMES } from "@/lib/code-highlighter";
import { splitCodeRefs } from "@/lib/code-refs";
import { imagePolicy, Markdown } from "./markdown";

// Calls show which text nodes `rehypeCodeRefs` saw, that is which blocks were parsed.
vi.mock("@/lib/code-refs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/code-refs")>();
  return { ...actual, splitCodeRefs: vi.fn(actual.splitCodeRefs) };
});

/** The text nodes parsed since `splitCodeRefs` was last cleared, blank ones left out. */
const parsedTexts = () =>
  vi
    .mocked(splitCodeRefs)
    .mock.calls.map(([text]) => text)
    .filter((text) => text.trim() !== "");

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

describe("Markdown while streaming", () => {
  it("shows an unterminated code fence as an incomplete code block", () => {
    const { container } = render(<Markdown text={"Here:\n\n```ts\nconst a = 1;"} streaming />);
    const block = container.querySelector('[data-streamdown="code-block"]');
    expect(block).toHaveAttribute("data-incomplete", "true");
    expect(block).toHaveTextContent("const a = 1;");
    expect(container).not.toHaveTextContent("```");
  });

  it("closes incomplete bold", () => {
    const { container } = render(<Markdown text="some **bold" streaming />);
    expect(container.querySelector('[data-streamdown="strong"]')).toHaveTextContent(/^bold$/);
    expect(container).not.toHaveTextContent("**");
  });

  it("shows a partial link as an incomplete link", () => {
    const { container } = render(<Markdown text="see [the docs](https://x.ex" streaming />);
    const link = screen.getByText("the docs");
    expect(link).toHaveAttribute("data-streamdown", "link");
    expect(link).toHaveAttribute("data-incomplete", "true");
    expect(container).not.toHaveTextContent("](");
  });

  it("marks code references while streaming and keeps the text once finished", () => {
    const text = "Look at @src/a.ts:3 first.\n\n```ts\nconst a = 1;\n```\n\nThen";
    const { container, rerender } = render(<Markdown text={text} streaming codeRefs />);
    expect(container.querySelector("[data-code-ref]")).toHaveTextContent("@src/a.ts:3");
    rerender(<Markdown text={text} codeRefs />);
    expect(container).toHaveTextContent("Look at @src/a.ts:3 first.");
    expect(container).toHaveTextContent("const a = 1;");
    expect(container).toHaveTextContent(/Then$/);
    expect(container.querySelector("[data-code-ref]")).toHaveTextContent("@src/a.ts:3");
  });

  it("parses only the last block on a delta, definitions or not", () => {
    const text = "See [the docs][1] at @src/a.ts:3.\n\n[1]: https://x.example/docs\n\nMore";
    const { rerender } = render(<Markdown text={text} streaming codeRefs />);
    // A reference shows as written until the message finishes.
    expect(screen.getByText(/the docs/)).not.toHaveAttribute("data-streamdown", "link");
    vi.mocked(splitCodeRefs).mockClear();
    rerender(<Markdown text={`${text} text`} streaming codeRefs />);
    expect(parsedTexts()).toEqual(["More text"]);
  });
});

describe("Markdown from streaming to finished", () => {
  const keyword = (container: HTMLElement) =>
    expect(within(container).getAllByText("const")[0]).toHaveStyle({
      "--sdm-c": "var(--syntax-keyword)",
    });

  // Streamdown's highlighted code body and Shiki load lazily: once loaded, every render goes
  // through the highlighter.
  beforeAll(async () => {
    const { container, unmount } = render(<Markdown text={"```ts\nconst warm = 1;\n```"} />);
    await waitFor(() => keyword(container), { timeout: 5_000 });
    unmount();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves a code fence unhighlighted until it closes", async () => {
    const highlight = vi.spyOn(lazyCodePlugin, "highlight");
    const open = "Here:\n\n```ts\nconst a = 1;\nconst b";
    const { container, rerender } = render(<Markdown text={open} streaming />);
    rerender(<Markdown text={`${open} = 2;`} streaming />);
    expect(container).toHaveTextContent("const a = 1;const b = 2;");
    expect(highlight).toHaveBeenCalled();
    for (const [options] of highlight.mock.calls) expect(options.themes).toBe(PLAIN_THEMES);

    rerender(<Markdown text={`${open} = 2;\n\`\`\`\n\nMore`} streaming />);
    await waitFor(() => keyword(container), { timeout: 5_000 });
    expect(highlight.mock.calls.at(-1)?.[0].themes).not.toBe(PLAIN_THEMES);
  });

  it("highlights a fence left open once the message finishes", async () => {
    const text = "```ts\nconst a = 1;";
    const { container, rerender } = render(<Markdown text={text} streaming />);
    rerender(<Markdown text={text} codeRefs />);
    await waitFor(() => keyword(container), { timeout: 5_000 });
  });

  it("keeps the earlier blocks' DOM, highlighting and parse", async () => {
    const text = "Look at @src/a.ts:3 first.\n\n```ts\nconst a = 1;\n```\n\nThen **more";
    const { container, rerender } = render(<Markdown text={text} streaming codeRefs />);
    await waitFor(() => keyword(container), { timeout: 5_000 });
    const paragraph = container.querySelector("p");
    const block = container.querySelector('[data-streamdown="code-block"]');
    const code = within(container).getAllByText("const")[0];
    const highlight = vi.spyOn(lazyCodePlugin, "highlight");
    vi.mocked(splitCodeRefs).mockClear();

    rerender(<Markdown text={text} codeRefs />);
    expect(container.querySelector("p")).toBe(paragraph);
    expect(container.querySelector('[data-streamdown="code-block"]')).toBe(block);
    expect(within(container).getAllByText("const")[0]).toBe(code);
    expect(highlight).not.toHaveBeenCalled();
    // Only the last block changes: its bold is no longer closed for it.
    expect(parsedTexts()).toEqual(["Then **more"]);
    expect(container.querySelector("[data-code-ref]")).toHaveTextContent("@src/a.ts:3");
    expect(container).toHaveTextContent(/Then \*\*more$/);
  });

  it("resolves link references in a finished message", () => {
    const text = "See [the docs][1].\n\nMore text.\n\n[1]: https://x.example/docs";
    const { rerender } = render(<Markdown text={text} streaming codeRefs />);
    rerender(<Markdown text={text} codeRefs />);
    expect(screen.getByText("the docs")).toHaveAttribute("data-streamdown", "link");
    expect(screen.queryByText(/\[1\]/)).toBeNull();
  });

  it("resolves references to definitions inside blockquotes and list items", () => {
    const text = [
      "See [the docs][1] and [the spec][2].",
      "> Sources:\n>\n> [1]: https://x.example/docs",
      "- Also:\n\n  [2]: https://x.example/spec",
    ].join("\n\n");
    const { rerender } = render(<Markdown text={text} streaming />);
    rerender(<Markdown text={text} />);
    expect(screen.getByText("the docs")).toHaveAttribute("data-streamdown", "link");
    expect(screen.getByText("the spec")).toHaveAttribute("data-streamdown", "link");
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

  it("doesn't cap a table's height", () => {
    const rows = Array.from({ length: 40 }, (_, i) => `| ${i} | x |`).join("\n");
    const { container } = render(<Markdown text={`| a | b |\n|---|---|\n${rows}`} />);
    const scroller = container.querySelector('[data-streamdown="table"]')?.parentElement;
    expect(scroller).not.toBeNull();
    expect(scroller?.style.maxHeight).toBe("");
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
        }),
      { timeout: 5_000 },
    );
    expect(container).toHaveTextContent("const answer: number = 42;");
  });
});
