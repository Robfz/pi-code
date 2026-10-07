/**
 * Text files inlined into a prompt message, in pi's CLI convention for `@file` arguments:
 * `<file name="…">\n<content>\n</file>\n` blocks ahead of the typed text. pi's RPC `prompt`
 * has no file field, so the web client sends attached text files this way.
 *
 * The web client adds a `length` attribute (the content's UTF-16 length) so a content line
 * `</file>` can't end a block early. Blocks without it (pi's CLI) end at the first `</file>` line.
 */

export interface FileBlock {
  name: string;
  text: string;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", '"': "&quot;", "<": "&lt;", "\n": "&#10;" };
const UNESCAPES: Record<string, string> = Object.fromEntries(
  Object.entries(ESCAPES).map(([char, entity]) => [entity, char]),
);

const escapeName = (name: string) => name.replace(/[&"<\n]/g, (char) => ESCAPES[char] as string);
const unescapeName = (name: string) =>
  name.replace(/&(?:amp|quot|lt|#10);/g, (entity) => UNESCAPES[entity] as string);

/** One `<file>` block, newline-terminated. */
export function formatFileBlock(file: FileBlock): string {
  return `<file name="${escapeName(file.name)}" length="${file.text.length}">\n${file.text}\n</file>\n`;
}

const HEADER = /<file name="([^\n]*?)"(?: length="(\d+)")?>\n/y;
const CLOSE = "\n</file>";

/** Whether a closing tag sits at `at`, followed by a newline or the end of `text`. */
function closesAt(text: string, at: number): boolean {
  const after = at + CLOSE.length;
  return text.startsWith(CLOSE, at) && (after === text.length || text[after] === "\n");
}

/** Where the content starting at `start` ends: at `length` when it checks out, else the first `</file>` line. */
function contentEnd(text: string, start: number, length: string | undefined): number {
  if (length !== undefined && closesAt(text, start + Number(length))) return start + Number(length);
  for (let at = text.indexOf(CLOSE, start); at !== -1; at = text.indexOf(CLOSE, at + 1)) {
    if (closesAt(text, at)) return at;
  }
  return -1;
}

/**
 * Splits the `<file>` blocks at the start of `text` from the rest (`body`). Only leading blocks
 * count, which is where pi's CLI and the web client put them.
 */
export function splitFileBlocks(text: string): { files: FileBlock[]; body: string } {
  const files: FileBlock[] = [];
  const header = new RegExp(HEADER);
  let end = 0;
  for (let match = header.exec(text); match !== null; match = header.exec(text)) {
    const start = header.lastIndex;
    const close = contentEnd(text, start, match[2]);
    if (close === -1) break;
    files.push({ name: unescapeName(match[1] as string), text: text.slice(start, close) });
    end = Math.min(close + CLOSE.length + 1, text.length);
    header.lastIndex = end;
  }
  return { files, body: text.slice(end) };
}
