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
