/**
 * Web Push subscription management for `/settings` (`docs/design/03-web-client.md`, "PWA"):
 * permission (from a user gesture) → `pushManager.subscribe` with the server's VAPID key →
 * `POST /api/push/subscriptions`. The same flow serves desktop Chrome.
 */

import { deletePushSubscription, getVapidKey, savePushSubscription } from "@/lib/api";

export type PushState = "unsupported" | "denied" | "enabled" | "disabled";

export interface PushStatus {
  state: PushState;
  /** Why push is unsupported, when it's not simply the browser. */
  reason?: string;
}

/** How long to wait for a service worker that is still installing. */
const READY_TIMEOUT_MS = 3_000;

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  const container = navigator.serviceWorker;
  const existing = await container.getRegistration();
  if (existing?.active) return existing;
  return Promise.race([
    container.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), READY_TIMEOUT_MS)),
  ]);
}

/** `applicationServerKey` from the base64url VAPID public key. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const base64 = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(current: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (!current) return true; // unknown: keep the subscription
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
}

const NO_WORKER = "The service worker isn't active (it only runs in the production build).";

export async function readPushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return { state: "unsupported" };
  if (Notification.permission === "denied") return { state: "denied" };
  const reg = await registration();
  if (!reg) return { state: "unsupported", reason: NO_WORKER };
  const subscription = await reg.pushManager.getSubscription();
  return {
    state: subscription && Notification.permission === "granted" ? "enabled" : "disabled",
  };
}

/**
 * Ask for permission and subscribe. Call straight from a click handler: the permission prompt
 * needs the user gesture, so it is the first thing awaited.
 */
export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "disabled";
  const reg = await registration();
  if (!reg) throw new Error(NO_WORKER);
  const key = urlBase64ToUint8Array(await getVapidKey());
  let subscription = await reg.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options?.applicationServerKey, key)) {
    // The server's VAPID key changed: the old subscription can't receive its pushes.
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  await savePushSubscription(subscription.toJSON());
  return "enabled";
}

export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  const subscription = reg ? await reg.pushManager.getSubscription() : null;
  if (subscription) {
    const { endpoint } = subscription;
    await subscription.unsubscribe();
    await deletePushSubscription(endpoint);
  }
  return Notification.permission === "denied" ? "denied" : "disabled";
}

/**
 * Re-upload an existing subscription (the server may have lost it); a no-op without one.
 * Never prompts.
 */
export async function syncPushSubscription(): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker.getRegistration();
  const subscription = await reg?.pushManager.getSubscription();
  if (subscription) await savePushSubscription(subscription.toJSON());
}
