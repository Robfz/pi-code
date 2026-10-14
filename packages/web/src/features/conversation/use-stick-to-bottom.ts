import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";

const THRESHOLD_PX = 80;

export interface StickToBottom {
  /** Jumps to the bottom and pins again. */
  toBottom: () => void;
  /**
   * Smooth-scrolls to `top` (instantly under reduced motion), unpinning when that's upward, as a
   * user's scroll up does.
   */
  scrollTo: (top: number) => void;
}

/**
 * Keeps a scroll container pinned to the bottom while its content grows, unless the user has
 * scrolled up. Starts pinned.
 */
export function useStickToBottom(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
): StickToBottom {
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
  const toBottom = useCallback(() => {
    pinned.current = true;
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [scrollRef]);
  const scrollTo = useCallback(
    (top: number) => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      // Unpinned before the first scroll event: content growing in between would otherwise pin
      // the scroller back to the bottom, cancelling the smooth scroll.
      if (top < scroller.scrollTop) pinned.current = false;
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      scroller.scrollTo({ top, behavior: reduced ? "instant" : "smooth" });
    },
    [scrollRef],
  );
  return useMemo(() => ({ toBottom, scrollTo }), [toBottom, scrollTo]);
}
