import { registerSW } from "virtual:pwa-register";
import { toast } from "sonner";
import { syncPushSubscription } from "@/lib/push";

/**
 * Register the service worker (production builds only). A new version waits for the user to
 * reload from the toast, so an update never interrupts a conversation.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const update = registerSW({
    immediate: true,
    onNeedRefresh() {
      toast("A new version of pi-code is available.", {
        id: "sw-update",
        duration: Number.POSITIVE_INFINITY,
        action: { label: "Reload", onClick: () => void update(true) },
      });
    },
    onRegisteredSW() {
      // Keep the server's copy of this device's subscription current.
      syncPushSubscription().catch(() => {});
    },
  });
}
