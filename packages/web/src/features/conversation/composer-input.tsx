import { findCodeRefs } from "@pi-code/protocol";
import {
  type ChangeEvent,
  type ComponentProps,
  type CompositionEvent,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import { CODE_REF_COLOR, splitCodeRefs } from "@/lib/code-refs";
import { cn } from "@/lib/utils";
import type { DraftSelection } from "@/store/drafts";

/** Box, font and wrapping shared by the textarea and its mirror, so their text lines up. */
const SHARED =
  "px-4 pt-[13px] pb-1 text-prose whitespace-pre-wrap break-words [scrollbar-gutter:stable]";

/** The text with every reference in a blue span, plus a zero-width space that keeps a final empty line's height. */
function highlight(text: string): ReactNode[] {
  const nodes = splitCodeRefs(text).map(({ text: part, match }) =>
    match ? (
      <span key={match.index} className={CODE_REF_COLOR}>
        {part}
      </span>
    ) : (
      part
    ),
  );
  return [...nodes, "\u200b"];
}

/** Whether removing `prev[from, to)` yields `next`. */
const removes = (prev: string, next: string, from: number, to: number) =>
  from >= 0 && to <= prev.length && prev.slice(0, from) + prev.slice(to) === next;

/** The range of `prev` an edit removed to give `next`, or null when it inserted anything. */
function removedRange(
  prev: string,
  next: string,
  before: DraftSelection,
): { from: number; to: number } | null {
  const count = prev.length - next.length;
  if (count <= 0) return null;
  // The selection before the edit places the deletion among repeated characters, which the
  // common prefix and suffix alone can't.
  const candidates =
    before.start !== before.end
      ? [[before.start, before.end]]
      : [
          [before.start - count, before.start],
          [before.start, before.start + count],
        ];
  for (const [from, to] of candidates as [number, number][]) {
    if (removes(prev, next, from, to)) return { from, to };
  }
  let prefix = 0;
  while (prefix < next.length && prev[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < next.length - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  return prefix + suffix === next.length ? { from: prefix, to: prev.length - suffix } : null;
}

/**
 * Whole-reference delete (`docs/design/07-code-review.md`): when an edit only removes text and
 * the removed range overlaps a reference of `prev` without covering it, the reference goes
 * whole. Returns the rewritten value and caret, or null to keep the edit as it is.
 */
export function deleteWholeReferences(
  prev: string,
  next: string,
  before: DraftSelection,
): { value: string; caret: number } | null {
  const removed = removedRange(prev, next, before);
  if (!removed) return null;
  let { from, to } = removed;
  for (const ref of findCodeRefs(prev)) {
    const refEnd = ref.index + ref.length;
    const overlaps = removed.from < refEnd && removed.to > ref.index;
    const covers = removed.from <= ref.index && removed.to >= refEnd;
    if (!overlaps || covers) continue;
    from = Math.min(from, ref.index);
    to = Math.max(to, refEnd);
  }
  if (from === removed.from && to === removed.to) return null;
  return { value: prev.slice(0, from) + prev.slice(to), caret: from };
}

function syncScroll(textarea: HTMLTextAreaElement | null, mirror: HTMLDivElement | null) {
  if (textarea && mirror) mirror.scrollTop = textarea.scrollTop;
}

export const selectionOf = (el: HTMLTextAreaElement): DraftSelection => ({
  start: el.selectionStart,
  end: el.selectionEnd,
});

type ComposerInputProps = Omit<ComponentProps<"textarea">, "value" | "onChange" | "children"> & {
  value: string;
  /** An edit, after whole-reference delete, with the textarea's selection afterwards. */
  onValueChange(value: string, selection: DraftSelection): void;
};

/**
 * The composer's textarea over an `aria-hidden` mirror that shows its text with references in
 * blue (`docs/design/07-code-review.md`, "Highlight overlay"). The textarea's own text is
 * transparent; caret, selection, IME and autocorrect stay native.
 */
export function ComposerInput({
  ref,
  value,
  onValueChange,
  className,
  onSelect,
  onKeyDown,
  onScroll,
  onCompositionStart,
  onCompositionEnd,
  ...props
}: ComposerInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  /** The selection before the coming edit. */
  const selectionRef = useRef<DraftSelection>({ start: value.length, end: value.length });
  /** Value and selection at `compositionstart`. */
  const compositionRef = useRef<{ value: string; selection: DraftSelection } | null>(null);

  const setRefs = useCallback(
    (el: HTMLTextAreaElement | null) => {
      textareaRef.current = el;
      if (typeof ref === "function") return ref(el);
      if (ref) ref.current = el;
    },
    [ref],
  );

  // The textarea scrolls itself to the caret as the text changes, not always with a `scroll` event.
  useLayoutEffect(() => {
    void value;
    syncScroll(textareaRef.current, mirrorRef.current);
  }, [value]);

  const track = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    selectionRef.current = selectionOf(event.currentTarget);
  };

  /** Applies whole-reference delete to an edit from `prev`, then reports the value. */
  const commit = (el: HTMLTextAreaElement, prev: string, before: DraftSelection) => {
    const rewrite = deleteWholeReferences(prev, el.value, before);
    if (rewrite) {
      el.value = rewrite.value;
      el.setSelectionRange(rewrite.caret, rewrite.caret);
    }
    selectionRef.current = selectionOf(el);
    onValueChange(el.value, selectionRef.current);
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget;
    // Rewriting the value mid-composition makes Gboard abort or duplicate it; `compositionend`
    // applies the rule to the whole composition instead.
    if ((event.nativeEvent as InputEvent).isComposing) {
      selectionRef.current = selectionOf(el);
      onValueChange(el.value, selectionRef.current);
      return;
    }
    commit(el, value, selectionRef.current);
  };

  return (
    <div className="relative">
      <div
        ref={mirrorRef}
        aria-hidden
        data-testid="composer-mirror"
        className={cn(SHARED, "pointer-events-none absolute inset-0 overflow-hidden")}
      >
        {highlight(value)}
      </div>
      <textarea
        {...props}
        ref={setRefs}
        value={value}
        onChange={handleChange}
        onSelect={(event) => {
          track(event);
          onSelect?.(event);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          track(event);
          onKeyDown?.(event);
        }}
        onScroll={(event) => {
          syncScroll(event.currentTarget, mirrorRef.current);
          onScroll?.(event);
        }}
        onCompositionStart={(event: CompositionEvent<HTMLTextAreaElement>) => {
          compositionRef.current = { value, selection: selectionOf(event.currentTarget) };
          onCompositionStart?.(event);
        }}
        onCompositionEnd={(event: CompositionEvent<HTMLTextAreaElement>) => {
          const start = compositionRef.current;
          compositionRef.current = null;
          if (start) commit(event.currentTarget, start.value, start.selection);
          onCompositionEnd?.(event);
        }}
        className={cn(
          SHARED,
          "relative block w-full resize-none bg-transparent text-transparent caret-foreground outline-none selection:bg-link/25 selection:text-transparent",
          className,
        )}
      />
    </div>
  );
}
