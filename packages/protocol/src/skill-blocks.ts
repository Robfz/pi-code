/**
 * An expanded skill command in a prompt message. pi expands a prompt `/skill:name args` into
 * `<skill name="…" location="…">\nReferences are relative to <dir>.\n\n<body>\n</skill>`,
 * followed by `\n\n<args>` when there are args. The web client shows the block as a compact card.
 *
 * pi doesn't escape attribute values or mark the content's length, so this follows pi's own
 * parser: the block must start the text, and its content ends at the first `\n</skill>` that
 * either ends the text or is followed by `\n\n` and the args.
 */

export interface SkillBlock {
  name: string;
  /** The skill file's path. */
  location: string;
  /** Everything between the header line and `</skill>`, the base-directory line included. */
  content: string;
}

const SKILL_BLOCK =
  /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** The `/skill:name args` command a skill block was expanded from. */
export function skillCommand(name: string, args: string): string {
  const trimmed = args.trim();
  return trimmed === "" ? `/skill:${name}` : `/skill:${name} ${trimmed}`;
}

/** Splits a leading `<skill>` block from the rest (`body`: the args, or ""). */
export function splitSkillBlock(text: string): { skill?: SkillBlock; body: string } {
  const match = SKILL_BLOCK.exec(text);
  if (!match) return { body: text };
  return {
    skill: { name: match[1] as string, location: match[2] as string, content: match[3] as string },
    body: match[4] ?? "",
  };
}
