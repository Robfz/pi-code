/**
 * Fake Push API for tests: `Notification`, `PushManager` and `navigator.serviceWorker` with a
 * registration whose `pushManager` records subscribe / unsubscribe.
 */

import { vi } from "vitest";

export interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON(): PushSubscriptionJSON;
  unsubscribe: ReturnType<typeof vi.fn>;
}

export function installPushEnv({
  permission = "default",
  requestResult = "granted",
  subscribedKey,
  withWorker = true,
}: {
  permission?: NotificationPermission;
  requestResult?: NotificationPermission;
  /** Start with an existing subscription made with this key. */
  subscribedKey?: Uint8Array;
  withWorker?: boolean;
} = {}) {
  let current: FakeSubscription | null = null;
  let count = 0;

  const makeSubscription = (key: Uint8Array | null): FakeSubscription => {
    const endpoint = `https://push.example/sub-${++count}`;
    const subscription: FakeSubscription = {
      endpoint,
      options: { applicationServerKey: key ? (key.slice().buffer as ArrayBuffer) : null },
      toJSON: () => ({ endpoint, keys: { p256dh: "p256", auth: "auth" } }),
      unsubscribe: vi.fn(async () => {
        if (current === subscription) current = null;
        return true;
      }),
    };
    return subscription;
  };
  if (subscribedKey) current = makeSubscription(subscribedKey);

  const FakeNotification = {
    permission: permission as NotificationPermission,
    requestPermission: vi.fn(async () => {
      FakeNotification.permission = requestResult;
      return requestResult;
    }),
  };

  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (options: PushSubscriptionOptionsInit) => {
      current = makeSubscription(options.applicationServerKey as Uint8Array);
      return current;
    }),
  };
  const registration = { active: {}, pushManager };
  const container = installServiceWorkerContainer(withWorker ? registration : undefined);

  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("PushManager", class {});

  return {
    Notification: FakeNotification,
    pushManager,
    container,
    current: () => current,
  };
}

/**
 * `navigator.serviceWorker` with an optional registration; `emit` delivers a message as if
 * posted by the service worker.
 */
export function installServiceWorkerContainer(registration?: object) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const container = {
    getRegistration: vi.fn(async () => registration),
    ready: registration ? Promise.resolve(registration) : new Promise(() => {}),
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
      listeners.delete(listener),
    emit: (data: unknown) => {
      for (const listener of listeners) listener(new MessageEvent("message", { data }));
    },
  };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  return container;
}

export function uninstallPushEnv(): void {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
}
