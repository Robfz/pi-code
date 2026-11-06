import type { ImageContent } from "@pi-code/protocol";
import { prepareImage } from "@/lib/image-resize";
import { readTextFile } from "@/lib/text-file";

/** A file attached to a composer draft. */
export type Attachment = { key: string; name: string } & (
  | { kind: "image"; image: ImageContent }
  | { kind: "text"; text: string }
);

let attachmentKey = 0;

/** Images go through `prepareImage` (only when the model takes images); anything else is text. */
export async function prepareAttachment(file: File, supportsImages: boolean): Promise<Attachment> {
  const key = `att-${++attachmentKey}`;
  if (file.type.startsWith("image/")) {
    if (!supportsImages) throw new Error(`The current model doesn't accept images (${file.name})`);
    return { key, name: file.name, kind: "image", image: await prepareImage(file) };
  }
  return { key, name: file.name, kind: "text", text: await readTextFile(file) };
}

/**
 * The prompt message for `typed` text with attached files' `<file>` blocks: the blocks first,
 * except after a `/skill:name` command, which pi expands only at the start of the message and
 * names up to the first space. The command stays first, so pi sends the skill ahead of the files
 * and the args.
 */
export function composePromptMessage(typed: string, fileBlocks: string): string {
  const skill = /^(\/skill:\S+)\s*([\s\S]*)$/.exec(typed);
  if (!skill) return fileBlocks + typed;
  const rest = fileBlocks + (skill[2] as string);
  return rest === "" ? (skill[1] as string) : `${skill[1]} ${rest}`;
}
