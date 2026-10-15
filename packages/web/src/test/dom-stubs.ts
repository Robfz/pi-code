/** jsdom stand-ins for viewport and layout APIs. */

import { vi } from "vitest";

/** Make `matchMedia(query)` report `matches` (e.g. a wide screen for split view). */
export function stubMatchMedia(matches: (query: string) => boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

/**
 * Give every element a rendered width of `width` px and install a `ResizeObserver` whose
 * `resize(width)` changes that width and notifies every observer. Undo with `vi.unstubAllGlobals`
 * and `vi.restoreAllMocks`.
 */
export function stubElementWidth(width: number): { resize(width: number): void } {
  let current = width;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        width: current,
        height: 0,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: current,
        bottom: 0,
      }) as DOMRect,
  );
  const observers = new Set<() => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly notify: () => void;
      constructor(callback: ResizeObserverCallback) {
        this.notify = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {
        observers.add(this.notify);
      }
      unobserve() {
        observers.delete(this.notify);
      }
      disconnect() {
        observers.delete(this.notify);
      }
    },
  );
  return {
    resize(next) {
      current = next;
      for (const notify of observers) notify();
    },
  };
}
