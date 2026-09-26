import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

describe("app", () => {
  it("answers the health check", async () => {
    const res = await createApp().request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, protocolVersion: 1 });
  });
});
