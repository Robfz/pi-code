/** Line references (`docs/design/07-code-review.md`) in text, for the views that show them. */

import { type CodeRefMatch, findCodeRefs } from "@pi-code/protocol";

/** The color of a line reference wherever it shows. */
export const CODE_REF_COLOR = "text-blue-600 dark:text-blue-400";

/** A run of text: a reference with its `match`, or plain text. */
export interface CodeRefPart {
  text: string;
  match?: CodeRefMatch;
}

/** `text` as plain and reference runs, in order; no run is empty. */
export function splitCodeRefs(text: string): CodeRefPart[] {
  const parts: CodeRefPart[] = [];
  let last = 0;
  for (const match of findCodeRefs(text)) {
    const end = match.index + match.length;
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ text: text.slice(match.index, end), match });
    last = end;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
