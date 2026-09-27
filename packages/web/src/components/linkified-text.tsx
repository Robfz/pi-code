import { Fragment } from "react";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCTUATION = /[).,;:!?\]}>]+$/;

export type TextPart = { type: "text"; text: string } | { type: "url"; url: string };

/** Split text into plain runs and URLs (trailing punctuation stays outside the URL). */
export function splitUrls(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0];
    const trailing = url.match(TRAILING_PUNCTUATION)?.[0] ?? "";
    // Keep a closing paren that balances one inside the URL (e.g. Wikipedia links).
    if (trailing.startsWith(")") && url.slice(0, -trailing.length).includes("(")) {
      url = url.slice(0, url.length - trailing.length + 1);
    } else if (trailing !== "") {
      url = url.slice(0, -trailing.length);
    }
    const start = match.index ?? 0;
    if (start > last) parts.push({ type: "text", text: text.slice(last, start) });
    parts.push({ type: "url", url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

/** Plain text with URLs as links, each followed by a copy button (MCP OAuth copy-paste flow). */
export function LinkifiedText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {splitUrls(text).map((part, index) =>
        part.type === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and static
          <Fragment key={index}>{part.text}</Fragment>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and static
          <span key={index} className="inline">
            <a
              href={part.url}
              target="_blank"
              rel="noreferrer noopener"
              className="break-all text-primary underline underline-offset-2"
            >
              {part.url}
            </a>
            <CopyButton text={part.url} label="Copy link" className="ml-0.5" />
          </span>
        ),
      )}
    </span>
  );
}
