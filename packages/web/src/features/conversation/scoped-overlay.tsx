import { createContext, useCallback, useContext, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Registers an open scoped sheet with the conversation screen; returns the unregister function.
 * While any is registered, the screen makes the controls the overlay covers `inert`.
 */
const ScopedCoverContext = createContext<(() => () => void) | undefined>(undefined);

export const ScopedCoverProvider = ScopedCoverContext.Provider;

/** For the conversation screen: whether a scoped sheet is open, and the context value. */
export function useScopedCover(): { covered: boolean; cover: () => () => void } {
  const [count, setCount] = useState(0);
  const cover = useCallback(() => {
    setCount((n) => n + 1);
    return () => setCount((n) => n - 1);
  }, []);
  return { covered: count > 0, cover };
}

/**
 * The dimmed backdrop of a conversation sheet scoped to `container` (the content column on
 * desktop). Such a sheet is non-modal, so the rest of the page stays usable, and Radix renders
 * no overlay for it; this one covers only the column, whose controls are `inert` meanwhile, so
 * keyboard focus leaving the sheet moves on to the rest of the page. Nothing without a container.
 */
export function ScopedOverlay({ container }: { container: HTMLElement | undefined }) {
  const cover = useContext(ScopedCoverContext);
  useLayoutEffect(() => (container && cover ? cover() : undefined), [container, cover]);
  if (!container) return null;
  return createPortal(
    <div
      data-slot="sheet-overlay"
      className="absolute inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
    />,
    container,
  );
}
