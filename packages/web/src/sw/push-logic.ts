/**
 * Pure decisions behind the service worker's `push` and `notificationclick` handlers
 * (`src/sw.ts`), kept free of DOM / WebWorker types so the app's tests can cover them.
 */

import type { PushPayload } from "@pi-code/protocol";

const KINDS: ReadonlySet<string> = new Set<PushPayload["kind"]>(["finished", "failed", "input"]);

/** Icons referenced by notifications (files in `public/icons`). */
export const NOTIFICATION_ICON = "/icons/icon-192.png";
export const NOTIFICATION_BADGE = "/icons/maskable-192.png";

/** Message types exchanged between the service worker and the app. */
export const SW_MESSAGE = {
  /** SW → app: a push arrived while a window was focused (no system notification shown). */
  push: "pi-code:push",
  /** SW → app: route to `url` (notification click on an existing window). */
  navigate: "pi-code:navigate",
} as const;

export interface SwPushMessage {
  type: typeof SW_MESSAGE.push;
  payload: PushPayload;
}

export interface SwNavigateMessage {
  type: typeof SW_MESSAGE.navigate;
  url: string;
}

export type SwMessage = SwPushMessage | SwNavigateMessage;

export function isSwMessage(value: unknown): value is SwMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  if (type === SW_MESSAGE.navigate) return typeof (value as { url?: unknown }).url === "string";
  if (type === SW_MESSAGE.push) return typeof (value as { payload?: unknown }).payload === "object";
  return false;
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Keep only same-origin paths: a payload URL like `https://evil/…` or `//evil` falls back to
 * the agent's conversation (or `/`).
 */
export function safeAppPath(url: string | undefined, agentId?: string): string {
  if (url?.startsWith("/") && !url.startsWith("//")) return url;
  return agentId ? `/agents/${encodeURIComponent(agentId)}` : "/";
}

/**
 * Parse a push message body (`PushPayload` JSON, as text or already parsed). Missing optional
 * fields get defaults; anything that isn't an object with an `agentId` yields `null`.
 */
export function parsePushPayload(data: unknown): PushPayload | null {
  let value = data;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const agentId = str(record, "agentId");
  if (!agentId) return null;
  const kind = str(record, "kind");
  const badge = record.badge;
  return {
    kind: kind !== undefined && KINDS.has(kind) ? (kind as PushPayload["kind"]) : "finished",
    agentId,
    title: str(record, "title") || "pi-code",
    body: str(record, "body") ?? "",
    badge: typeof badge === "number" && Number.isFinite(badge) ? Math.max(0, Math.floor(badge)) : 0,
    url: safeAppPath(str(record, "url"), agentId),
  };
}

export type BadgeAction = { type: "set"; count: number } | { type: "clear" };

export function badgeAction(count: number): BadgeAction {
  return count > 0 ? { type: "set", count } : { type: "clear" };
}

/** The subset of a window `Client` the decisions look at. */
export interface ClientInfo {
  url: string;
  focused: boolean;
  visibilityState?: string;
}

/** A focused, visible pi-code window already shows the change — skip the system notification. */
export function hasFocusedClient(clients: readonly ClientInfo[]): boolean {
  return clients.some((c) => c.focused && c.visibilityState !== "hidden");
}

export interface NotificationSpec {
  title: string;
  options: {
    body: string;
    tag: string;
    data: { url: string };
    icon: string;
    badge: string;
  };
}

export function notificationFor(payload: PushPayload): NotificationSpec {
  return {
    title: payload.title,
    options: {
      body: payload.body,
      tag: payload.agentId,
      data: { url: payload.url },
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_BADGE,
    },
  };
}

/** The target path stored on a notification (`data.url`), defaulting to `/`. */
export function notificationUrl(data: unknown): string {
  const url =
    typeof data === "object" && data !== null ? (data as { url?: unknown }).url : undefined;
  return safeAppPath(typeof url === "string" ? url : undefined);
}

export type ClickTarget =
  /** Focus `clients[index]`; `navigate` is false when it already shows `url`. */
  | { action: "focus"; index: number; url: string; navigate: boolean }
  | { action: "open"; url: string };

/**
 * Where a notification click goes: a window already on `path`, else the focused window, else
 * any pi-code window (all navigated to `path`), else a new window.
 */
export function resolveClickTarget(
  clients: readonly ClientInfo[],
  path: string,
  origin: string,
): ClickTarget {
  const url = new URL(path, origin).href;
  const sameOrigin = clients
    .map((client, index) => ({ client, index }))
    .filter(({ client }) => {
      try {
        return new URL(client.url).origin === new URL(origin).origin;
      } catch {
        return false;
      }
    });
  const exact = sameOrigin.find(({ client }) => client.url === url);
  if (exact) return { action: "focus", index: exact.index, url, navigate: false };
  const focused = sameOrigin.find(({ client }) => client.focused);
  const any = focused ?? sameOrigin[0];
  if (any) return { action: "focus", index: any.index, url, navigate: true };
  return { action: "open", url };
}
