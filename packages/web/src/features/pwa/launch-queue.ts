import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

/** The slice of the Launch Handler API used here (Chromium only; not in the DOM typings). */
interface LaunchParams {
  readonly targetURL?: string | null;
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

/**
 * The document's URL at load. On a fresh launch Chrome also enqueues params for it, which the
 * router has already handled (and `/?new` has already been stripped from).
 */
const initialUrl = typeof window !== "undefined" ? window.location.href : "";

/**
 * With the manifest's `focus-existing` launch handler, launching the installed app (icon,
 * shortcut, link) focuses the open window instead of loading the URL; route there in-app, so the
 * open conversations stay loaded. The consumer can't be unset, and the router lives as long as
 * the page, so there's nothing to clean up.
 */
export function useLaunchQueue(): void {
  const router = useRouter();
  useEffect(() => {
    const queue = (window as { launchQueue?: LaunchQueue }).launchQueue;
    if (!queue) return;
    let first = true;
    queue.setConsumer(({ targetURL }) => {
      const initial = first && targetURL === initialUrl;
      first = false;
      if (!targetURL || initial) return;
      const url = new URL(targetURL);
      if (url.origin !== window.location.origin) return;
      router.history.push(url.pathname + url.search + url.hash);
    });
  }, [router]);
}
