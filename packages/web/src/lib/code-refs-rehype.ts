/**
 * Rehype plugin that marks line references (`@path:N`, `docs/design/07-code-review.md`,
 * "Clickable references") in rendered Markdown as `span[data-code-ref]` buttons. Text inside `pre`
 * and `a` is left alone. Each text node is scanned on its own, so a node start (inline code,
 * emphasis) counts as a reference start.
 */

import { findCodeRefs } from "@pi-code/protocol";
import type { Element, ElementContent, Root, RootContent, Text } from "hast";

const SKIPPED = new Set(["pre", "a"]);

export const CODE_REF_CLASS = [
  "cursor-pointer",
  "text-blue-600",
  "hover:underline",
  "dark:text-blue-400",
];

/** `node` split into text and reference spans, or `null` without references. */
function split(node: Text): ElementContent[] | null {
  const matches = findCodeRefs(node.value);
  if (matches.length === 0) return null;
  const parts: ElementContent[] = [];
  let last = 0;
  for (const { index, length } of matches) {
    if (index > last) parts.push({ type: "text", value: node.value.slice(last, index) });
    parts.push({
      type: "element",
      tagName: "span",
      properties: { dataCodeRef: "", role: "button", tabIndex: 0, className: CODE_REF_CLASS },
      children: [{ type: "text", value: node.value.slice(index, index + length) }],
    });
    last = index + length;
  }
  if (last < node.value.length) parts.push({ type: "text", value: node.value.slice(last) });
  return parts;
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
