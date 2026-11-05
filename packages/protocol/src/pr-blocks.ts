/**
 * Pull request context in a prompt message (`docs/design/10-pr-review.md`): a leading
 * `<pr …>\n<text>\n</pr>\n` block, written by the server when a conversation is attached to a PR
 * (`/pr`) and when it is refreshed, followed by the request to the agent. The web client shows the
 * block as a compact card.
 *
 * Like `<file>` blocks, a block carries its content's UTF-16 `length`, so a `</pr>` line in a PR
 * description can't end it early.
 */

import { blockContentEnd, escapeAttribute, unescapeAttribute } from "./blocks.ts";
import type { PrState } from "./types.ts";

export interface PrBlock {
  number: number;
  title: string;
  state: PrState;
  url: string;
  /** A refresh's update rather than the context sent at `/pr`. */
  update: boolean;
  text: string;
}

/** One `<pr>` block, newline-terminated. */
export function formatPrBlock(block: PrBlock): string {
  const attributes = [
    `number="${block.number}"`,
    `state="${block.state}"`,
    `title="${escapeAttribute(block.title)}"`,
    `url="${escapeAttribute(block.url)}"`,
    ...(block.update ? ['update="true"'] : []),
    `length="${block.text.length}"`,
  ];
  return `<pr ${attributes.join(" ")}>\n${block.text}\n</pr>\n`;
}

const HEADER =
  /<pr number="(\d+)" state="(open|closed|merged)" title="([^\n"]*)" url="([^\n"]*)"( update="true")? length="(\d+)">\n/y;
const CLOSE = "\n</pr>";

/** Splits the `<pr>` blocks at the start of `text` from the rest (`body`). */
export function splitPrBlocks(text: string): { prs: PrBlock[]; body: string } {
  const prs: PrBlock[] = [];
  const header = new RegExp(HEADER);
  let end = 0;
  for (let match = header.exec(text); match !== null; match = header.exec(text)) {
    const start = header.lastIndex;
    const close = blockContentEnd(text, start, match[6], CLOSE);
    if (close === -1) break;
    prs.push({
      number: Number(match[1]),
      state: match[2] as PrState,
      title: unescapeAttribute(match[3] as string),
      url: unescapeAttribute(match[4] as string),
      update: match[5] !== undefined,
      text: text.slice(start, close),
    });
    end = Math.min(close + CLOSE.length + 1, text.length);
    header.lastIndex = end;
  }
  return { prs, body: text.slice(end) };
}

/** A one-line label for a block: `#12 Title`, or `#12 Title (updated)`. */
export function prBlockLabel(block: Pick<PrBlock, "number" | "title" | "update">): string {
  return `#${block.number} ${block.title}${block.update ? " (updated)" : ""}`;
}
