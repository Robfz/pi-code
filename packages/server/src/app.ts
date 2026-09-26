import { PROTOCOL_VERSION } from "@pi-code/protocol";
import { Hono } from "hono";

/** Builds the Hono app. Routes are chained so `AppType` carries them for the typed `hc` client. */
export function createApp() {
  return new Hono()
    .basePath("/api")
    .get("/health", (c) => c.json({ ok: true as const, protocolVersion: PROTOCOL_VERSION }));
}

export type AppType = ReturnType<typeof createApp>;
