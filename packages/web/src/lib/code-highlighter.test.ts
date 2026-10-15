import { describe, expect, it } from "vitest";
import { lazyCodePlugin } from "./code-highlighter";

type HighlightResult = NonNullable<ReturnType<typeof lazyCodePlugin.highlight>>;

function highlight(code: string): Promise<HighlightResult> {
  return new Promise((resolve) => {
    const options = { code, language: "ts", themes: lazyCodePlugin.getThemes() } as const;
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
    expect(style("const")).toEqual({
      color: "var(--syntax-keyword)",
      "--shiki-dark": "var(--syntax-keyword)",
    });
    expect(style('"yes"')).toMatchObject({ color: "var(--syntax-string)" });
    expect(style("// why")).toMatchObject({ color: "var(--syntax-comment)" });
    expect(style("=")).toMatchObject({ color: "var(--syntax-punctuation)" });
    expect(style("length")).toMatchObject({ color: "var(--syntax-property)" });
    expect(result.bg).toMatch(/^#00000000;/);
  });
});
