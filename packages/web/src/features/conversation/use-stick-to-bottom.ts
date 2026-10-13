import { type RefObject, useCallback, useEffect, useRef } from "react";

const THRESHOLD_PX = 80;

/**
 * Keeps a scroll container pinned to the bottom while its content grows, unless the user has
 * scrolled up. Starts pinned. Returns a function that jumps to the bottom and pins again.
 */
export function useStickToBottom(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
): () => void {
  const pinned = useRef(true);
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    let lastTop = scroller.scrollTop;
    const onScroll = () => {
      const top = scroller.scrollTop;
      const distance = scroller.scrollHeight - top - scroller.clientHeight;
      // Scrolling up unpins at once: otherwise content laid out on the way up (entries use
      // `content-visibility: auto`) resizes while still within the threshold and snaps back down.
      // A scrollTop clamped by the scroller growing (keyboard closing) stays at the bottom.
      if (top < lastTop && distance >= 1) pinned.current = false;
      else if (distance < THRESHOLD_PX) pinned.current = true;
      lastTop = top;
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
  return useCallback(() => {
    pinned.current = true;
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [scrollRef]);
}
