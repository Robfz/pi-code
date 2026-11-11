/**
 * A PR guide in a prompt message (`docs/design/11-pr-guide.md`, "Delivery"): a leading
 * `<pr-guide …>\n<text>\n</pr-guide>\n` block, written by the server when a conversation's PR guide
 * is ready, followed by the request to the agent. The web client shows the block as a compact
 * card.
 *
 * Like `<pr>` blocks, a block carries its content's UTF-16 `length`, so a `</pr-guide>` line in a
 * section's explanation can't end it early.
 */

import { blockContentEnd, escapeAttribute, unescapeAttribute } from "./blocks.ts";

export interface PrGuideBlock {
  number: number;
  title: string;
  url: string;
  text: string;
}

/** One `<pr-guide>` block, newline-terminated. */
export function formatPrGuideBlock(block: PrGuideBlock): string {
  const attributes = [
    `number="${block.number}"`,
    `title="${escapeAttribute(block.title)}"`,
    `url="${escapeAttribute(block.url)}"`,
    `length="${block.text.length}"`,
  ];
  return `<pr-guide ${attributes.join(" ")}>\n${block.text}\n</pr-guide>\n`;
}

const HEADER = /<pr-guide number="(\d+)" title="([^\n"]*)" url="([^\n"]*)" length="(\d+)">\n/y;
const CLOSE = "\n</pr-guide>";

/** Splits the `<pr-guide>` blocks at the start of `text` from the rest (`body`). */
export function splitPrGuideBlocks(text: string): { guides: PrGuideBlock[]; body: string } {
  const guides: PrGuideBlock[] = [];
  const header = new RegExp(HEADER);
  let end = 0;
  for (let match = header.exec(text); match !== null; match = header.exec(text)) {
    const start = header.lastIndex;
    const close = blockContentEnd(text, start, match[4], CLOSE);
    if (close === -1) break;
    guides.push({
      number: Number(match[1]),
      title: unescapeAttribute(match[2] as string),
      url: unescapeAttribute(match[3] as string),
      text: text.slice(start, close),
    });
    end = Math.min(close + CLOSE.length + 1, text.length);
    header.lastIndex = end;
  }
  return { guides, body: text.slice(end) };
}

/** A one-line label for a block: `Review guide · #12 Title`, marked up front so it survives truncation. */
export function prGuideBlockLabel(block: Pick<PrGuideBlock, "number" | "title">): string {
  return `Review guide · #${block.number} ${block.title}`;
}
