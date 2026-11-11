/**
 * A prompt message's leading blocks and typed text, in the order they're written: an expanded
 * skill (pi's), the attached `<file>` blocks, `<pr>` blocks (PR review), then `<pr-guide>` blocks
 * (a PR's guide). The composer keeps a skill command ahead of attached files, so pi's skill block
 * comes first.
 */

import { type FileBlock, splitFileBlocks } from "./file-blocks.ts";
import { type PrBlock, splitPrBlocks } from "./pr-blocks.ts";
import { type PrGuideBlock, splitPrGuideBlocks } from "./pr-guide-blocks.ts";
import { type SkillBlock, splitSkillBlock } from "./skill-blocks.ts";

export interface SplitUserMessage {
  skill?: SkillBlock;
  files: FileBlock[];
  prs: PrBlock[];
  guides: PrGuideBlock[];
  /** What follows the blocks: the typed text, or a skill's args. */
  body: string;
}

/** Splits a user message's text into its leading blocks and the rest. */
export function splitUserMessage(text: string): SplitUserMessage {
  const { skill, body: args } = splitSkillBlock(text);
  const { files, body: rest } = splitFileBlocks(args);
  const { prs, body: afterPrs } = splitPrBlocks(rest);
  const { guides, body } = splitPrGuideBlocks(afterPrs);
  return { ...(skill && { skill }), files, prs, guides, body };
}
