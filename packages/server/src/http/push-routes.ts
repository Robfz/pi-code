import type { PushUnsubscribeBody } from "@pi-code/protocol";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { ApiError } from "../errors.ts";
import type { PushService } from "../push/push-service.ts";
import { parseSubscription } from "../push/subscriptions.ts";

function parseUnsubscribe(value: unknown): PushUnsubscribeBody {
  if (typeof value === "object" && value !== null) {
    const endpoint = (value as Record<string, unknown>).endpoint;
    if (typeof endpoint === "string" && endpoint !== "") return { endpoint };
  }
  throw new ApiError("invalid_body", "expected { endpoint: string }");
}

/** `/api/push` routes (`not_found` when push is disabled). Chained so the route types reach `AppType`. */
export function pushRoutes(service: PushService | undefined) {
  const push = (): PushService => {
    if (service === undefined) throw new ApiError("not_found", "push notifications are disabled");
    return service;
  };
  return new Hono()
    .get("/vapid-key", (c) => c.json({ publicKey: push().publicKey }, 200))
    .post(
      "/subscriptions",
      validator("json", (value) => parseSubscription(value)),
      async (c) => {
        await push().subscribe(c.req.valid("json"));
        return c.body(null, 204);
      },
    )
    .delete(
      "/subscriptions",
      validator("json", (value) => parseUnsubscribe(value)),
      async (c) => {
        await push().unsubscribe(c.req.valid("json").endpoint);
        return c.body(null, 204);
      },
    );
}
