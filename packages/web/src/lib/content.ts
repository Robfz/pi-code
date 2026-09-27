import type { ImageContent, TextContent } from "@pi-code/protocol";

type Content = string | readonly (TextContent | ImageContent | { type: string })[] | undefined;

/** Concatenated text parts of a message content (string or content array). */
export function contentText(content: Content): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** Image parts of a message content. */
export function contentImages(content: Content): ImageContent[] {
  if (content === undefined || typeof content === "string") return [];
  return content.filter((part): part is ImageContent => part.type === "image");
}

export function imageSrc(image: ImageContent): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/** Text of a tool result / partial result (`{ content: [...] }`), or "" when absent. */
export function toolResultText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return contentText(content as (TextContent | ImageContent)[]);
}

/** Last path segment of an absolute path ("/" for the root). */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name === "" ? "/" : name;
}

/** Pretty-print a JSON value; strings pass through. */
export function prettyJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
