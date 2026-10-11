import { CODE_REF_COLOR, splitCodeRefs } from "@/lib/code-refs";
import { cn } from "@/lib/utils";
import { useOpenReference } from "./open-reference";

/** Plain text with its line references as blue buttons that open those lines. */
export function CodeRefText({ text }: { text: string }) {
  const open = useOpenReference();
  return splitCodeRefs(text).map(({ text: part, match }) =>
    match ? (
      <button
        key={match.index}
        type="button"
        data-code-ref=""
        onClick={() => open(match)}
        className={cn("inline cursor-pointer text-left hover:underline", CODE_REF_COLOR)}
      >
        {part}
      </button>
    ) : (
      part
    ),
  );
}
