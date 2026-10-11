/**
 * Streamdown's Shiki plugin (`@streamdown/code`), loaded on first use so Shiki stays out of the
 * entry chunk. Streamdown only calls `getThemes` (synchronously, for its context) and
 * `highlight` (which may answer later through its callback), so a stand-in can answer both
 * until the real plugin arrives. Languages and themes are further lazy chunks inside Shiki.
 */

import type { CodeHighlighterPlugin } from "streamdown";

const THEMES = ["vitesse-light", "vitesse-dark"] as const satisfies [string, string];

let plugin: CodeHighlighterPlugin | null = null;
let loading: Promise<CodeHighlighterPlugin> | null = null;

function load(): Promise<CodeHighlighterPlugin> {
  loading ??= import("@streamdown/code").then(({ createCodePlugin }) => {
    plugin = createCodePlugin({ themes: [...THEMES] }) as unknown as CodeHighlighterPlugin;
    return plugin;
  });
  return loading;
}

export const lazyCodePlugin: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getThemes: () => [...THEMES],
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
