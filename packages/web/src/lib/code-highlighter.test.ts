import { describe, expect, it, vi } from "vitest";
import { lazyCodePlugin, PLAIN_THEMES } from "./code-highlighter";

/** The languages Shiki created highlighters for, and the lines and tasks it tokenised in. */
const log = vi.hoisted(() => ({ created: [] as unknown[], lines: [] as string[] }));

/** Marks, in `log.lines`, a task the highlighter resumes in; a line can't contain it. */
const TASK = "\n";

vi.mock("shiki", async (importOriginal) => {
  const shiki = await importOriginal<typeof import("shiki")>();
  const createHighlighter: typeof shiki.createHighlighter = async (options) => {
    log.created.push(...options.langs);
    const highlighter = await shiki.createHighlighter(options);
    const { codeToTokens } = highlighter;
    highlighter.codeToTokens = (code, tokensOptions) => {
      log.lines.push(code);
      return codeToTokens(code, tokensOptions);
    };
    return highlighter;
  };
  return { ...shiki, createHighlighter };
});

type HighlightResult = NonNullable<ReturnType<typeof lazyCodePlugin.highlight>>;

function highlight(code: string, language = "ts"): Promise<HighlightResult> {
  return new Promise((resolve) => {
    const options = { code, language, themes: lazyCodePlugin.getThemes() };
    const result = lazyCodePlugin.highlight(options, resolve);
    if (result) resolve(result);
  });
}

describe("lazyCodePlugin", () => {
  it("highlights with one theme for light and dark", () => {
    const [light, dark] = lazyCodePlugin.getThemes();
    expect(light).toBe(dark);
  });

  it("colours tokens with the palette's syntax variables in both modes", async () => {
    const result = await highlight('const answer = "yes"; // why\nanswer.length;');
    const tokens = result.tokens.flat();
    const style = (content: string) =>
      tokens.find((token) => token.content.trim() === content)?.htmlStyle;
    expect(style("const")).toEqual({ color: "var(--syntax-keyword)" });
    expect(style('"yes"')).toMatchObject({ color: "var(--syntax-string)" });
    expect(style("// why")).toMatchObject({ color: "var(--syntax-comment)" });
    expect(style("=")).toMatchObject({ color: "var(--syntax-punctuation)" });
    expect(style("length")).toMatchObject({ color: "var(--syntax-property)" });
    expect(result.bg).toBe("#00000000");
  });

  it("continues each line from the grammar state the previous one ended in", async () => {
    const result = await highlight("/* a\nconst b */\nconst c = 1;");
    const colors = result.tokens.map((line) => line.map((token) => token.htmlStyle?.color));
    expect(colors[1]?.every((c) => c === "var(--syntax-comment)")).toBe(true);
    expect(colors[2]?.[0]).toBe("var(--syntax-keyword)");
  });

  it("highlights a language Shiki doesn't bundle as plain text", async () => {
    const result = await highlight("a b\nc", "no-such-language");
    expect(result.tokens.map((line) => line.map((token) => token.content))).toEqual([
      ["a b"],
      ["c"],
    ]);
  });

  it("yields to other tasks while it highlights a long block", async () => {
    await highlight("const warm = 1;");
    const code = Array.from({ length: 1000 }, (_, i) => `const a${i} = ${i};`).join("\n");
    let highlighted = false;
    const done = highlight(code).then(() => {
      highlighted = true;
    });
    const otherTask = new Promise((resolve) => setTimeout(resolve, 0)).then(() => highlighted);
    expect(await otherTask).toBe(false);
    await done;
  });

  it("shares one highlighter between a language's aliases", async () => {
    await highlight("let a = 1;", "ts");
    await highlight("let b = 2;", "typescript");
    await highlight("let c = 3;", " TS ");
    expect(log.created.filter((lang) => lang === "ts" || lang === "typescript")).toEqual([
      "typescript",
    ]);
  });

  it("gives highlights that start together one slice per task between them", async () => {
    await highlight("const warm = 1;");
    const Channel = MessageChannel;
    vi.stubGlobal(
      "MessageChannel",
      class {
        readonly port1;
        readonly port2;
        constructor() {
          const { port1, port2 } = new Channel();
          this.port2 = port2;
          this.port1 = {
            close: () => port1.close(),
            set onmessage(resume: () => void) {
              port1.onmessage = () => {
                log.lines.push(TASK);
                resume();
              };
            },
          };
        }
      },
    );
    const block = (name: string) =>
      Array.from({ length: 1000 }, (_, i) => `${name}${i} = ${i};`).join("\n");
    log.lines.length = 0;
    await Promise.all([highlight(block("a")), highlight(block("b"))]);
    vi.unstubAllGlobals();
    const tasks: string[][] = [[]];
    for (const line of log.lines) {
      if (line === TASK) tasks.push([]);
      else tasks.at(-1)?.push(line);
    }
    expect(tasks.length).toBeGreaterThan(2);
    for (const task of tasks) {
      expect(new Set(task.map((line) => line[0])).size).toBeLessThanOrEqual(1);
    }
  });

  it("answers PLAIN_THEMES at once with one plain token per line", () => {
    const options = { code: "const a = 1;\n\nb", language: "ts", themes: PLAIN_THEMES } as const;
    const plain = { color: "inherit", bgColor: "transparent", htmlStyle: {}, offset: 0 };
    expect(lazyCodePlugin.highlight(options)).toEqual({
      bg: "transparent",
      fg: "inherit",
      tokens: [
        [{ content: "const a = 1;", ...plain }],
        [{ content: "", ...plain }],
        [{ content: "b", ...plain }],
      ],
    });
  });
});
