import { useCallback, useState } from "react";

/**
 * Whether the attached element's rendered width (border box) is at least `minWidth` px, kept in
 * sync by a `ResizeObserver`. State changes only when the width crosses `minWidth`. Returns the
 * callback ref to attach and the flag (false before attaching).
 */
export function useWidthAtLeast<T extends Element>(
  minWidth: number,
): [(element: T) => () => void, boolean] {
  const [atLeast, setAtLeast] = useState(false);
  const ref = useCallback(
    (element: T) => {
      const measure = () => setAtLeast(element.getBoundingClientRect().width >= minWidth);
      measure();
      if (typeof ResizeObserver === "undefined") return () => {};
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    },
    [minWidth],
  );
  return [ref, atLeast];
}
