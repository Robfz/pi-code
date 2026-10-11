/**
 * Rehype plugin that marks line references (`@path:N`, `docs/design/07-code-review.md`,
 * "Clickable references") in rendered Markdown as `span[data-code-ref]` buttons. Text inside `pre`
 * and `a` is left alone. Each text node is scanned on its own, so a node start (inline code,
 * emphasis) counts as a reference start.
 */

import type { Element, ElementContent, Root, RootContent, Text } from "hast";
import { CODE_REF_COLOR, splitCodeRefs } from "./code-refs";

const SKIPPED = new Set(["pre", "a"]);

/** A mono chip, as in assistant text (`index.css` drops the chip inside inline code). */
export const CODE_REF_CLASS = [
  "cursor-pointer",
  "hover:underline",
  CODE_REF_COLOR,
  "bg-link/12",
  "rounded-[5px]",
  "px-[0.38em]",
  "py-[0.12em]",
  "font-mono",
  "text-[0.875em]",
  "tracking-[-0.01em]",
];

/** `node` split into text and reference spans, or `null` without references. */
function split(node: Text): ElementContent[] | null {
  const parts = splitCodeRefs(node.value);
  if (!parts.some((part) => part.match)) return null;
  return parts.map(({ text, match }) =>
    match
      ? {
          type: "element",
          tagName: "span",
          properties: { dataCodeRef: "", role: "button", tabIndex: 0, className: CODE_REF_CLASS },
          children: [{ type: "text", value: text }],
        }
      : { type: "text", value: text },
  );
}

function visit(parent: Root | Element) {
  const children: RootContent[] = [];
  for (const child of parent.children) {
    if (child.type === "text") {
      children.push(...(split(child) ?? [child]));
      continue;
    }
    if (child.type === "element" && !SKIPPED.has(child.tagName)) visit(child);
    children.push(child);
  }
  // A text node's replacements are element content, so the children keep the parent's kind.
  parent.children = children as ElementContent[];
}

export function rehypeCodeRefs() {
  return (tree: Root) => {
    visit(tree);
  };
}
