import {
  prBlockLabel,
  splitFileBlocks,
  splitPrBlocks,
  splitSkillBlock,
  type UserMessage,
} from "@pi-code/protocol";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { contentText } from "@/lib/content";
import { cn } from "@/lib/utils";
import { useConversation } from "@/store/context";
import { selectPendingUser } from "@/store/selectors";
import { PENDING_TURN_ID, selectTurns } from "@/store/turns";

/** Room left above a prompt the outline jumps to. */
const JUMP_MARGIN_PX = 16;

interface Prompt {
  /** Its turn's id, which `TurnView` puts on the message as `data-prompt-id`. */
  id: string;
  title: string;
}

/**
 * A prompt's outline title: its PR for a `/pr` prompt or a PR update, else the first non-blank
 * line of its text after an expanded skill and attached files, else `/skill:name`.
 */
export function promptTitle(content: UserMessage["content"]): string {
  const { skill, body: args } = splitSkillBlock(contentText(content));
  const { prs, body } = splitPrBlocks(splitFileBlocks(args).body);
  if (prs[0] !== undefined) return prBlockLabel(prs[0]);
  const line = body
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();
  return line ?? (skill ? `/skill:${skill.name}` : "");
}

/** The active branch's prompts with text, the pending one last. */
function usePrompts(): Prompt[] {
  const turns = useConversation(selectTurns);
  const pendingUser = useConversation(selectPendingUser);
  return useMemo(() => {
    const users = turns.flatMap((turn) => (turn.user ? [{ id: turn.id, user: turn.user }] : []));
    if (pendingUser) users.push({ id: PENDING_TURN_ID, user: pendingUser });
    return users.flatMap(({ id, user }) => {
      const title = promptTitle(user.content);
      return title === "" ? [] : [{ id, title }];
    });
  }, [turns, pendingUser]);
}

function promptElements(scroller: HTMLElement): Map<string | undefined, HTMLElement> {
  const elements = scroller.querySelectorAll<HTMLElement>("[data-prompt-id]");
  return new Map(Array.from(elements, (element) => [element.dataset.promptId, element]));
}

/**
 * The last prompt whose top is above a third of the scroller's height; once scrolled to the end,
 * above its bottom, so prompts too close to the end to reach that line can be current.
 */
function currentPrompt(scroller: HTMLElement, prompts: readonly Prompt[]): string | undefined {
  const elements = promptElements(scroller);
  const placed = prompts.flatMap((prompt) => {
    const element = elements.get(prompt.id);
    return element ? [{ id: prompt.id, element }] : [];
  });
  const box = scroller.getBoundingClientRect();
  const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 1;
  const line = atEnd ? box.bottom : box.top + scroller.clientHeight / 3;
  // Prompts are in document order, so their tops ascend: binary search for the first below.
  let low = 0;
  let high = placed.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const top = placed[mid]?.element.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    if (top <= line) low = mid + 1;
    else high = mid;
  }
  return placed[low - 1]?.id;
}

/**
 * An "On this page" list of the conversation's prompts in the transcript's right margin, the one
 * in view marked; a click scrolls to it. Rendered inside the centred transcript column (which is
 * `relative`) and shown only while the scroller, a container, leaves the margin room for it.
 */
export function ConversationOutline({
  scrollRef,
  scrollTo,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  scrollTo: (top: number) => void;
}) {
  const prompts = usePrompts();
  const [current, setCurrent] = useState<string>();
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || prompts.length < 2) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Hidden (no room in the margin): skip the layout reads. Resizes that show it schedule
      // another update.
      if (navRef.current?.checkVisibility?.() === false) return;
      setCurrent(currentPrompt(scroller, prompts));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    schedule();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scrollRef, prompts]);

  // Keeps the current item within the outline's own scroll. Not `scrollIntoView`: that would
  // scroll the transcript too.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || current === undefined) return;
    const item = nav.querySelector<HTMLElement>('[aria-current="true"]');
    if (!item) return;
    if (item.offsetTop < nav.scrollTop) nav.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = item.offsetTop + item.offsetHeight - nav.clientHeight;
    }
  }, [current]);

  const jump = (id: string) => {
    const scroller = scrollRef.current;
    const element = scroller && promptElements(scroller).get(id);
    if (!scroller || !element) return;
    // Turns off screen keep a placeholder height until rendered (`content-visibility: auto`), so
    // a far jump can land slightly off where turns it passes resize.
    const offset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scrollTo(scroller.scrollTop + offset - JUMP_MARGIN_PX);
  };

  if (prompts.length < 2) return null;
  return (
    <div className="absolute inset-y-0 left-full ml-4 hidden w-56 py-8 @min-[78rem]:block">
      <nav
        ref={navRef}
        aria-label="Conversation outline"
        className="sticky top-8 max-h-[calc(100cqh-4rem)] overflow-y-auto"
      >
        <ul className="border-l">
          {prompts.map((prompt) => {
            const active = prompt.id === current;
            return (
              <li key={prompt.id}>
                <button
                  type="button"
                  title={prompt.title}
                  aria-current={active ? "true" : undefined}
                  onClick={() => jump(prompt.id)}
                  className={cn(
                    "-ml-px block w-full truncate border-l py-1 pr-1 pl-3 text-left text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
                    active
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground",
                  )}
                >
                  {prompt.title}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
