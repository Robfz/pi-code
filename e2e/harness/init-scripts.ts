/**
 * Scripts for `context.addInitScript`: Playwright serializes each function, so it must be
 * self-contained (no imports, no closures over module scope).
 */

/**
 * Tracks the page's `EventSource`s so a test can drop the app's stream (`window.__e2e.dropStream`).
 * `context.setOffline` doesn't cut an open SSE response, and aborting the request with
 * `page.route` only affects the next connection.
 */
export function installStreamControl(): void {
  const open = new Set<EventSource>();
  class TrackedEventSource extends EventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      open.add(this);
    }

    override close(): void {
      open.delete(this);
      super.close();
    }
  }
  window.EventSource = TrackedEventSource;
  window.__e2e = Object.assign(window.__e2e ?? {}, {
    dropStream() {
      for (const source of [...open]) {
        source.close();
        source.dispatchEvent(new Event("error"));
      }
    },
  });
}
