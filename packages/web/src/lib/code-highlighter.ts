/**
 * Streamdown's Shiki plugin (`@streamdown/code`), loaded on first use so Shiki stays out of the
 * entry chunk. Streamdown only calls `getThemes` (synchronously, for its context) and
 * `highlight` (which may answer later through its callback), so a stand-in can answer both
 * until the real plugin arrives. Languages are further lazy chunks inside Shiki.
 */

import type { ThemeInput } from "@streamdown/code";
import type { CodeHighlighterPlugin } from "streamdown";

type SyntaxToken =
  | "fg"
  | "keyword"
  | "string"
  | "function"
  | "comment"
  | "number"
  | "property"
  | "variable"
  | "type"
  | "punctuation";

const color = (token: SyntaxToken) => `var(--syntax-${token})`;

/**
 * Colours are the palette's `--syntax-*` tokens (`index.css`, `palettes.css`), which Shiki
 * passes through as strings, so the palette and the light / dark theme restyle highlighted code
 * without highlighting again. The scopes follow Vitesse's, folded into those tokens.
 */
const SYNTAX_THEME = {
  name: "pi-code-syntax",
  type: "light",
  // Hex, not `transparent`: Shiki swaps non-hex colours for placeholders and leaves the
  // background's swapped.
  colors: { "editor.background": "#00000000", "editor.foreground": color("fg") },
  settings: [
    { settings: { foreground: color("fg") } },
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: color("comment") },
    },
    {
      scope: [
        "delimiter.bracket",
        "delimiter",
        "keyword.operator.rest",
        "keyword.operator.spread",
        "keyword.operator.type.annotation",
        "keyword.operator.relational",
        "keyword.operator.assignment",
        "keyword.operator.type",
        "meta.brace",
        "meta.type.annotation",
        "storage.type.function.arrow",
        "punctuation",
      ],
      settings: { foreground: color("punctuation") },
    },
    {
      scope: [
        "keyword",
        "keyword.operator",
        "keyword.other.unit",
        "storage",
        "storage.type",
        "support.type.builtin",
        "constant.language",
        "entity.name.tag",
        "tag.html",
        "meta.module-reference",
        "punctuation.definition.template-expression",
        "markup.heading",
      ],
      settings: { foreground: color("keyword") },
    },
    {
      scope: [
        "string",
        "string punctuation.section.embedded source",
        "attribute.value",
        "punctuation.definition.string",
        "string.regexp",
        "constant.other.reference.link",
        "string.other.link",
      ],
      settings: { foreground: color("string") },
    },
    {
      scope: ["entity", "entity.name", "entity.name.function"],
      settings: { foreground: color("function") },
    },
    {
      scope: ["constant.numeric", "number", "keyword.operator.quantifier.regexp"],
      settings: { foreground: color("number") },
    },
    {
      scope: [
        "support",
        "property",
        "meta.property-name",
        "meta.object-literal.key",
        "entity.name.tag.yaml",
        "attribute.name",
      ],
      settings: { foreground: color("property") },
    },
    {
      scope: [
        "variable",
        "identifier",
        "constant",
        "entity.name.constant",
        "variable.language",
        "meta.definition.variable",
        "support.constant",
        "entity.other.attribute-name",
      ],
      settings: { foreground: color("variable") },
    },
    {
      scope: [
        "support.type.primitive",
        "entity.name.type",
        "namespace",
        "type.identifier",
        "markup.quote",
      ],
      settings: { foreground: color("type") },
    },
    {
      scope: [
        "variable.parameter.function",
        "storage.modifier.package",
        "storage.modifier.import",
        "text.html.derivative",
      ],
      settings: { foreground: color("fg") },
    },
    { scope: ["markup.inserted"], settings: { foreground: "var(--diff-add)" } },
    { scope: ["markup.deleted"], settings: { foreground: "var(--diff-del)" } },
  ],
} satisfies ThemeInput;

/** Streamdown highlights for a light and a dark theme; the one theme serves both. */
const THEMES: [ThemeInput, ThemeInput] = [SYNTAX_THEME, SYNTAX_THEME];

let plugin: CodeHighlighterPlugin | null = null;
let loading: Promise<CodeHighlighterPlugin> | null = null;

function load(): Promise<CodeHighlighterPlugin> {
  loading ??= import("@streamdown/code").then(({ createCodePlugin }) => {
    plugin = createCodePlugin({ themes: THEMES }) as unknown as CodeHighlighterPlugin;
    return plugin;
  });
  return loading;
}

export const lazyCodePlugin: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getThemes: () => THEMES,
  // Unknown languages fall back to plain text inside the real plugin.
  supportsLanguage: (language) => plugin?.supportsLanguage(language) ?? true,
  getSupportedLanguages: () => plugin?.getSupportedLanguages() ?? [],
  highlight(options, callback) {
    if (plugin) return plugin.highlight(options, callback);
    load()
      .then((real) => {
        // A cached result comes back synchronously instead of through the callback.
        const result = real.highlight(options, callback);
        if (result) callback?.(result);
      })
      .catch(() => {
        // Highlighting is cosmetic: the plain code block stays.
      });
    return null;
  },
};
