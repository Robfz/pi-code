import { Hono } from "hono";
import { validator } from "hono/validator";
import { parseSidebarPatch, type SidebarStateStore, sidebarView } from "../store/sidebar-state.ts";

/**
 * `PATCH /api/sidebar`: sets pinned / collapsed flags per path, idempotently, so devices
 * changing different paths at once don't undo each other. Every change also reaches every
 * client as a `sidebar` frame. Chained so the route types reach `AppType`.
 */
export function sidebarRoutes(sidebar: SidebarStateStore) {
  return new Hono().patch(
    "/",
    validator("json", (value) => parseSidebarPatch(value)),
    async (c) => c.json({ sidebar: sidebarView(await sidebar.update(c.req.valid("json"))) }, 200),
  );
}
