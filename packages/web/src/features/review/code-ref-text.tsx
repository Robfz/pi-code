import { findCodeRefs } from "@pi-code/protocol";
import { Fragment, type ReactNode } from "react";
import { useOpenReference } from "./open-reference";

/** Plain text with its line references as blue buttons that open those lines. */
export function CodeRefText({ text }: { text: string }) {
  const open = useOpenReference();
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of findCodeRefs(text)) {
    const { index, length } = match;
    if (index > last) parts.push(<Fragment key={last}>{text.slice(last, index)}</Fragment>);
    parts.push(
      <button
        key={index}
        type="button"
        data-code-ref=""
        onClick={() => open(match)}
        className="inline cursor-pointer text-left text-blue-600 hover:underline dark:text-blue-400"
      >
        {text.slice(index, index + length)}
      </button>,
    );
    last = index + length;
  }
  if (last < text.length) parts.push(<Fragment key={last}>{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}
