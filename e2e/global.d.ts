export {};

declare global {
  /** Test hooks the init scripts install on `window.__e2e` (the perf suite adds its own). */
  interface E2EHooks {
    /**
     * Ends every open `EventSource` as a network failure the browser gave up on would: closed,
     * then an `error` event. The app reconnects on its own after a backoff.
     */
    dropStream(): void;
  }

  interface Window {
    __e2e: E2EHooks;
  }
}
