import type { AppType } from "@pi-code/server";
import { hc } from "hono/client";

/** Typed API client; routes come from the server's `AppType`. */
export const api = hc<AppType>(window.location.origin);
