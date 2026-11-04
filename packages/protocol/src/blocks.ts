/**
 * What `<file>` and `<pr>` blocks share: attribute escaping and finding a block's end. Internal to
 * the package (not re-exported by `index.ts`).
 */

const ESCAPES: Record<string, string> = { "&": "&amp;", '"': "&quot;", "<": "&lt;", "\n": "&#10;" };
const UNESCAPES: Record<string, string> = Object.fromEntries(
  Object.entries(ESCAPES).map(([char, entity]) => [entity, char]),
);

/** An attribute value as the blocks write it: `&`, `"`, `<` and line breaks escaped. */
export const escapeAttribute = (value: string) =>
  value.replace(/[&"<\n]/g, (char) => ESCAPES[char] as string);
export const unescapeAttribute = (value: string) =>
  value.replace(/&(?:amp|quot|lt|#10);/g, (entity) => UNESCAPES[entity] as string);

/** Whether the closing tag `close` sits at `at`, followed by a newline or the end of `text`. */
function closesAt(text: string, at: number, close: string): boolean {
  const after = at + close.length;
  return text.startsWith(close, at) && (after === text.length || text[after] === "\n");
}

/**
 * Where the content starting at `start` ends: at `length` when it checks out, else the first
 * `close` line (`\n</tag>`).
 */
export function blockContentEnd(
  text: string,
  start: number,
  length: string | undefined,
  close: string,
): number {
  if (length !== undefined && closesAt(text, start + Number(length), close)) {
    return start + Number(length);
  }
  for (let at = text.indexOf(close, start); at !== -1; at = text.indexOf(close, at + 1)) {
    if (closesAt(text, at, close)) return at;
  }
  return -1;
}
