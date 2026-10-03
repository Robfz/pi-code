import { type RefObject, useEffect, useRef } from "react";

const THRESHOLD_PX = 80;

/**
 * Keeps a scroll container pinned to the bottom while its content grows, unless the user has
 * scrolled up. Starts pinned.
 */
export function useStickToBottom(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
): void {
  const pinned = useRef(true);
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const onScroll = () => {
      pinned.current =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < THRESHOLD_PX;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    if (typeof ResizeObserver === "undefined") {
      return () => scroller.removeEventListener("scroll", onScroll);
    }
    const observer = new ResizeObserver(() => {
      if (pinned.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [scrollRef, contentRef]);
}
