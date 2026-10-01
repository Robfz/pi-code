import { useCallback, useSyncExternalStore } from "react";

const hasMatchMedia = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function";

/** Whether a CSS media query matches, kept in sync with viewport changes. */
function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!hasMatchMedia()) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener?.("change", onChange);
      return () => list.removeEventListener?.("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => hasMatchMedia() && window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * Desktop shell, docked sidebar and full-width transcript from this width. Tailwind's `lg`
 * (64rem), so `lg:` classes switch together with it whatever the browser's font size.
 */
export const DESKTOP_QUERY = "(min-width: 64rem)";

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
