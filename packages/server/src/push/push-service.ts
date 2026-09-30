import { basename } from "node:path";
import type { AgentInfo, AssistantMessage, PushPayload } from "@pi-code/protocol";
import webpush from "web-push";
import type { AttentionTrigger } from "../agents/pipeline.ts";
import type { StoredSubscription, SubscriptionStore } from "./subscriptions.ts";
import type { VapidDetails } from "./vapid.ts";

/** Push message lifetime at the push service: 1 h. */
const PUSH_TTL_SECONDS = 3600;
/** Maximum length of a notification body. */
const BODY_MAX_CHARS = 140;

export interface PushSendOptions {
  TTL: number;
  urgency: "high" | "normal";
  vapidDetails: VapidDetails;
}

/** Sends one push message. Rejects with an error carrying `statusCode` on HTTP failures. */
export type PushSender = (
  subscription: Pick<StoredSubscription, "endpoint" | "keys" | "expirationTime">,
  payload: string,
  options: PushSendOptions,
) => Promise<unknown>;

/** `web-push`'s `sendNotification`. */
const webPushSender: PushSender = (subscription, payload, options) =>
  webpush.sendNotification(
    {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      ...(subscription.expirationTime != null
        ? { expirationTime: subscription.expirationTime }
        : {}),
    },
    payload,
    {
      TTL: options.TTL,
      urgency: options.urgency,
      vapidDetails: {
        subject: options.vapidDetails.subject,
        publicKey: options.vapidDetails.publicKey,
        privateKey: options.vapidDetails.privateKey,
      },
    },
  );

/** Where the push service looks up agents (the `AgentManager`). */
interface PushAgents {
  get(id: string): { info(): AgentInfo } | undefined;
  list(): AgentInfo[];
}

interface PushServiceDeps {
  vapid: VapidDetails;
  store: SubscriptionStore;
  agents: PushAgents;
  send?: PushSender;
}

/** Collapses whitespace and cuts `text` to `max` characters (code points), with an ellipsis. */
export function truncate(text: string, max = BODY_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max
    ? flat
    : `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join(" ");
}

function statusCodeOf(e: unknown): number | undefined {
  const code = (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : undefined;
}

/**
 * Web Push: subscriptions, VAPID, and the payloads for attention triggers (finished / failed /
 * input). Sends to every subscription; subscriptions the push service reports gone (404/410)
 * are removed.
 */
export class PushService {
  private readonly deps: PushServiceDeps;
  private readonly send: PushSender;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: PushServiceDeps) {
    this.deps = deps;
    this.send = deps.send ?? webPushSender;
  }

  get publicKey(): string {
    return this.deps.vapid.publicKey;
  }

  subscribe(sub: Omit<StoredSubscription, "createdAt">): Promise<void> {
    return this.deps.store.add(sub);
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.deps.store.remove(endpoint);
  }

  /** The payload for a trigger; `undefined` when the agent is gone. */
  payloadFor(trigger: AttentionTrigger): PushPayload | undefined {
    const info = this.deps.agents.get(trigger.agentId)?.info();
    if (info === undefined) return undefined;
    const title = info.sessionName || basename(info.cwd) || "pi-code";
    const badge = this.deps.agents.list().filter((a) => a.attention !== "none").length;
    let body: string;
    if ("message" in trigger) {
      body =
        trigger.kind === "finished"
          ? truncate(assistantText(trigger.message)) || "Run finished"
          : truncate(trigger.message.errorMessage ?? "") || "Run failed";
    } else if ("request" in trigger) {
      body = truncate(trigger.request.title ?? "") || "Input needed";
    } else {
      body = truncate(`Trust project ${basename(trigger.trustPrompt.cwd)}?`) || "Input needed";
    }
    return {
      kind: trigger.kind,
      agentId: trigger.agentId,
      title: truncate(title, 80) || "pi-code",
      body,
      badge,
      url: `/agents/${encodeURIComponent(trigger.agentId)}`,
    };
  }

  /** Sends the trigger's notification to every subscription. Never rejects. */
  notify(trigger: AttentionTrigger): Promise<void> {
    const run = this.deliver(trigger).catch((e) => {
      console.error("[push] notification failed:", e);
    });
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run));
    return run;
  }

  /** Resolves once every notification sent so far is delivered (or failed). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private async deliver(trigger: AttentionTrigger): Promise<void> {
    const payload = this.payloadFor(trigger);
    if (payload === undefined) return;
    const subs = await this.deps.store.list();
    if (subs.length === 0) return;
    const body = JSON.stringify(payload);
    const options: PushSendOptions = {
      TTL: PUSH_TTL_SECONDS,
      urgency: payload.kind === "input" ? "high" : "normal",
      vapidDetails: this.deps.vapid,
    };
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await this.send(sub, body, options);
        } catch (e) {
          const status = statusCodeOf(e);
          if (status === 404 || status === 410) {
            await this.deps.store.remove(sub.endpoint);
            return;
          }
          const host = URL.canParse(sub.endpoint) ? new URL(sub.endpoint).host : "?";
          console.warn(
            `[push] send to ${host} failed${status ? ` (${status})` : ""}: ${(e as Error).message}`,
          );
        }
      }),
    );
  }
}
