/// <reference lib="webworker" />
/**
 * Service worker (`docs/design/03-web-client.md`, "PWA"):
 *
 * - Precaches the app shell; navigations fall back to `index.html` (except `/api/…`); API
 *   requests always go to the network (no route registered for them).
 * - `push`: set / clear the app badge; show a notification unless a pi-code window is focused
 *   (that window gets a message instead, so it can refresh and toast).
 * - `notificationclick`: focus a pi-code window and route it to the conversation, else open one.
 * - `pushsubscriptionchange`: resubscribe and upload the new subscription.
 */

import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import {
  badgeAction,
  hasFocusedClient,
  notificationFor,
  notificationUrl,
  parsePushPayload,
  resolveClickTarget,
  SW_MESSAGE,
  type SwMessage,
} from "./sw/push-logic.ts";

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), { denylist: [/^\/api(\/|$)/] }),
);

// A new version waits until the app asks (the "Update available" toast), so a reload never
// happens mid-conversation; the first install takes control right away.
self.addEventListener("message", (event) => {
  if ((event.data as { type?: unknown } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
});
clientsClaim();

function windowClients(): Promise<readonly WindowClient[]> {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true });
}

async function updateBadge(count: number): Promise<void> {
  const nav = self.navigator;
  try {
    const action = badgeAction(count);
    if (action.type === "set" && "setAppBadge" in nav) await nav.setAppBadge(action.count);
    if (action.type === "clear" && "clearAppBadge" in nav) await nav.clearAppBadge();
  } catch {
    // Badging is best effort (unsupported or not installed).
  }
}

function post(client: Client, message: SwMessage): void {
  try {
    client.postMessage(message);
  } catch {
    // The window went away.
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      // `parsePushPayload` parses the JSON text (and rejects anything that isn't JSON).
      const payload = parsePushPayload(event.data?.text() ?? null);
      if (!payload) return;
      await updateBadge(payload.badge);
      const clients = await windowClients();
      for (const client of clients) post(client, { type: SW_MESSAGE.push, payload });
      if (hasFocusedClient(clients)) return;
      const mac = self.navigator.userAgent.includes("Macintosh");
      const { title, options } = notificationFor(payload, mac);
      await self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = notificationUrl(event.notification.data);
  event.waitUntil(
    (async () => {
      const clients = await windowClients();
      const target = resolveClickTarget(clients, path, self.location.origin);
      if (target.action === "open") {
        await self.clients.openWindow(target.url);
        return;
      }
      const client = clients[target.index];
      if (!client) {
        await self.clients.openWindow(target.url);
        return;
      }
      const focused = await client.focus().catch(() => client);
      if (!target.navigate) return;
      // Route inside the running app (keeps its state); a full navigation is the fallback.
      try {
        focused.postMessage({ type: SW_MESSAGE.navigate, url: path } satisfies SwMessage);
      } catch {
        await focused.navigate(target.url).catch(() => self.clients.openWindow(target.url));
      }
    })(),
  );
});

interface PushSubscriptionChangeEvent extends ExtendableEvent {
  readonly oldSubscription: PushSubscription | null;
  readonly newSubscription: PushSubscription | null;
}

self.addEventListener("pushsubscriptionchange", (event) => {
  const change = event as PushSubscriptionChangeEvent;
  change.waitUntil(
    (async () => {
      let subscription = change.newSubscription;
      if (!subscription && change.oldSubscription) {
        subscription = await self.registration.pushManager.subscribe(
          change.oldSubscription.options,
        );
      }
      if (!subscription) return;
      await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
    })().catch(() => {}),
  );
});
