/**
 * Text files inlined into a prompt message, in pi's CLI convention for `@file` arguments:
 * `<file name="…">\n<content>\n</file>\n` blocks ahead of the typed text. pi's RPC `prompt`
 * has no file field, so the web client sends attached text files this way.
 *
 * The web client adds a `length` attribute (the content's UTF-16 length) so a content line
 * `</file>` can't end a block early. Blocks without it (pi's CLI) end at the first `</file>` line.
 */

import { blockContentEnd, escapeAttribute, unescapeAttribute } from "./blocks.ts";

export interface FileBlock {
  name: string;
  text: string;
}

/** One `<file>` block, newline-terminated. */
export function formatFileBlock(file: FileBlock): string {
  return `<file name="${escapeAttribute(file.name)}" length="${file.text.length}">\n${file.text}\n</file>\n`;
}

const HEADER = /<file name="([^\n]*?)"(?: length="(\d+)")?>\n/y;
const CLOSE = "\n</file>";

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
    const close = blockContentEnd(text, start, match[2], CLOSE);
    if (close === -1) break;
    files.push({ name: unescapeAttribute(match[1] as string), text: text.slice(start, close) });
    end = Math.min(close + CLOSE.length + 1, text.length);
    header.lastIndex = end;
  }
  return { files, body: text.slice(end) };
}
