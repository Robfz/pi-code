import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { useLineSelection } from "@/features/review/line-selection";
import { useReviewStore } from "@/features/review/review-state";
import { useDrafts } from "@/store/drafts";
import { FakeEventSource } from "./fake-event-source";

// jsdom lacks these; next-themes and the router use them.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
window.scrollTo = () => {};
// sonner's swipe handling (toast action clicks).
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollTo = () => {};
// jsdom has no ResizeObserver; cmdk lists and Radix poppers measure themselves with one, and a
// tooltip opens whenever its timer fires between a click's hover and press. This one never
// reports; tests that need resize notifications stub their own (see `stubElementWidth`).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// jsdom has no EventSource; the live registry's streams become scriptable fakes.
globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

afterEach(() => {
  cleanup();
  FakeEventSource.instances = [];
  useDrafts.setState({ drafts: {} });
  useLineSelection.setState({ pending: null });
  useReviewStore.setState({ reviews: {} });
  localStorage.removeItem("pi-code:review");
});
