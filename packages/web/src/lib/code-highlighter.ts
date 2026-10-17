/**
 * Streamdown's code highlighter: Shiki, loaded on first use so it stays out of the entry chunk.
 * Streamdown only calls `getThemes` (synchronously, for its context) and `highlight` (which may
 * answer later through its callback), so the plugin answers both before Shiki arrives. Languages
 * are further lazy chunks inside Shiki.
 */

import type { BundledLanguage, Highlighter, TokensResult } from "shiki";
import type { CodeHighlighterPlugin, ThemeInput } from "streamdown";

type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;

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

/**
 * Themes that ask for the code as plain lines, without Shiki. `Markdown` passes these for a code
 * fence still streaming, which would otherwise be tokenised again on every delta.
 */
export const PLAIN_THEMES: [ThemeInput, ThemeInput] = [SYNTAX_THEME, SYNTAX_THEME];

/** Streamdown's own unhighlighted rendering: one inherit-coloured token per line. */
function plainResult(code: string): HighlightResult {
  return {
    bg: "transparent",
    fg: "inherit",
    tokens: code
      .split("\n")
      .map((content) => [
        { content, color: "inherit", bgColor: "transparent", htmlStyle: {}, offset: 0 },
      ]),
  };
}

/**
 * Main-thread time highlights run before they yield to the event loop. A grammar compiles its
 * rules on first use, and every line costs time warm too: in one task, a 12-line block in a
 * language not used yet takes about 90 ms, a 400-line block about 75 ms.
 */
const SLICE_MS = 8;

/** What Shiki highlights a block as: a language it bundles, or plain text. */
type Language = BundledLanguage | "text";

/** Shiki's bundled languages by id and alias, once Shiki has loaded. */
let languages: Map<string, BundledLanguage> | null = null;
/** Shiki, loading or loaded, as the function that creates a highlighter for a language. */
let loading: Promise<(lang: Language) => Promise<Highlighter>> | null = null;
/**
 * One highlighter per language id, shared by its aliases: loading a language into a shared one
 * reloads the grammars that embed it, which would swap the grammar under a highlight still
 * running.
 */
const highlighters = new Map<Language, Promise<Highlighter>>();

function loadShiki(): Promise<(lang: Language) => Promise<Highlighter>> {
  loading ??= Promise.all([import("shiki"), import("shiki/engine/javascript")]).then(
    ([{ bundledLanguagesInfo, createHighlighter }, { createJavaScriptRegexEngine }]) => {
      languages = new Map(
        bundledLanguagesInfo.flatMap(({ id, aliases = [] }) =>
          [id, ...aliases].map((name) => [name, id as BundledLanguage] as const),
        ),
      );
      // Forgiving: a pattern the engine can't translate never matches instead of throwing.
      const engine = createJavaScriptRegexEngine({ forgiving: true });
      return (lang) => createHighlighter({ themes: [SYNTAX_THEME], langs: [lang], engine });
    },
  );
  return loading;
}

async function highlighterFor(language: string): Promise<[Highlighter, Language]> {
  const create = await loadShiki();
  const lang = languages?.get(language.trim().toLowerCase()) ?? "text";
  let highlighter = highlighters.get(lang);
  if (!highlighter) {
    highlighter = create(lang);
    highlighters.set(lang, highlighter);
  }
  return [await highlighter, lang];
}

/** Resolves in a task of its own, so input and rendering can run first. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * When the current slice ends, shared by all highlights: blocks that start highlighting together
 * resume in the same task, and each would otherwise take a slice of its own there.
 */
let sliceEnd = 0;

/**
 * Shiki's tokens for `code`, a line at a time, each line continuing from the grammar state the
 * previous one ended in, yielding whenever the slice is spent. Token offsets count from their
 * line's start (Streamdown doesn't read them).
 */
async function tokenize(code: string, language: string): Promise<HighlightResult> {
  const [highlighter, lang] = await highlighterFor(language);
  // Only the light theme: Shiki tokenises once per theme, and Streamdown's dark styles fall back
  // to the light colours.
  const options = { lang, themes: { light: SYNTAX_THEME.name } };
  const tokens: HighlightResult["tokens"] = [];
  let result: TokensResult | undefined;
  for (const line of code.split(/\r?\n/)) {
    if (performance.now() > sliceEnd) {
      await nextTask();
      sliceEnd = performance.now() + SLICE_MS;
    }
    result = highlighter.codeToTokens(line, { ...options, grammarState: result?.grammarState });
    tokens.push(...result.tokens);
  }
  return { ...result, tokens };
}

/** Highlighted code by language and code, answered synchronously when a block renders again. */
const results = new Map<string, HighlightResult>();
/** Highlights in progress, so blocks asking for the same code share one. */
const pending = new Map<string, Promise<HighlightResult>>();

export const lazyCodePlugin: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getThemes: () => THEMES,
  // Unknown languages highlight as plain text.
  supportsLanguage: (language) => languages?.has(language.trim().toLowerCase()) ?? true,
  getSupportedLanguages: () => [...(languages?.keys() ?? [])],
  highlight({ code, language, themes }, callback) {
    if (themes === PLAIN_THEMES) return plainResult(code);
    // A fence's language can't contain a newline.
    const key = `${language}\n${code}`;
    const result = results.get(key);
    if (result) return result;
    let highlighting = pending.get(key);
    if (!highlighting) {
      highlighting = tokenize(code, language)
        .then((tokens) => {
          results.set(key, tokens);
          return tokens;
        })
        .finally(() => pending.delete(key));
      pending.set(key, highlighting);
    }
    highlighting.then(callback).catch(() => {
      // Highlighting is cosmetic: the plain code block stays.
    });
    return null;
  },
};
