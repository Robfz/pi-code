import { describe, expect, it } from "vitest";
import {
  badgeAction,
  hasFocusedClient,
  isSwMessage,
  NOTIFICATION_BADGE,
  NOTIFICATION_ICON,
  notificationFor,
  notificationUrl,
  parsePushPayload,
  resolveClickTarget,
  SW_MESSAGE,
  safeAppPath,
} from "./push-logic";

const ORIGIN = "https://mac.tailnet.ts.net";

const payload = {
  kind: "finished",
  agentId: "a1",
  title: "alpha",
  body: "All tests pass.",
  badge: 2,
  url: "/agents/a1",
} as const;

describe("parsePushPayload", () => {
  it("accepts the contract payload, parsed or as JSON text", () => {
    expect(parsePushPayload(payload)).toEqual(payload);
    expect(parsePushPayload(JSON.stringify(payload))).toEqual(payload);
  });

  it("fills defaults for missing optional fields", () => {
    expect(parsePushPayload({ agentId: "a b" })).toEqual({
      kind: "finished",
      agentId: "a b",
      title: "pi-code",
      body: "",
      badge: 0,
      url: "/agents/a%20b",
    });
  });

  it("normalizes the badge and the kind", () => {
    expect(parsePushPayload({ ...payload, badge: -3 })?.badge).toBe(0);
    expect(parsePushPayload({ ...payload, badge: 2.7 })?.badge).toBe(2);
    expect(parsePushPayload({ ...payload, badge: "4" })?.badge).toBe(0);
    expect(parsePushPayload({ ...payload, kind: "input" })?.kind).toBe("input");
    expect(parsePushPayload({ ...payload, kind: "weird" })?.kind).toBe("finished");
  });

  it("keeps only same-origin paths", () => {
    expect(parsePushPayload({ ...payload, url: "https://evil.example/x" })?.url).toBe("/agents/a1");
    expect(parsePushPayload({ ...payload, url: "//evil.example/x" })?.url).toBe("/agents/a1");
    expect(parsePushPayload({ ...payload, url: "/agents/a1/tree" })?.url).toBe("/agents/a1/tree");
  });

  it("rejects garbage", () => {
    expect(parsePushPayload(null)).toBeNull();
    expect(parsePushPayload("not json")).toBeNull();
    expect(parsePushPayload([payload])).toBeNull();
    expect(parsePushPayload({ title: "no agent" })).toBeNull();
    expect(parsePushPayload(42)).toBeNull();
  });
});

describe("badgeAction", () => {
  it("sets a positive count and clears at zero", () => {
    expect(badgeAction(3)).toEqual({ type: "set", count: 3 });
    expect(badgeAction(0)).toEqual({ type: "clear" });
  });
});

describe("hasFocusedClient", () => {
  it("is true only for a focused, visible window", () => {
    expect(hasFocusedClient([])).toBe(false);
    expect(hasFocusedClient([{ url: `${ORIGIN}/`, focused: false }])).toBe(false);
    expect(
      hasFocusedClient([
        { url: `${ORIGIN}/`, focused: false, visibilityState: "visible" },
        { url: `${ORIGIN}/agents/a1`, focused: true, visibilityState: "visible" },
      ]),
    ).toBe(true);
    expect(
      hasFocusedClient([{ url: `${ORIGIN}/`, focused: true, visibilityState: "hidden" }]),
    ).toBe(false);
  });
});

describe("notificationFor", () => {
  it("tags by agent (re-alerting on replacement) and carries the URL", () => {
    expect(notificationFor(payload)).toEqual({
      title: "alpha",
      options: {
        body: "All tests pass.",
        tag: "a1",
        renotify: true,
        data: { url: "/agents/a1" },
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_BADGE,
      },
    });
  });

  it("reads the URL back from notification data", () => {
    expect(notificationUrl({ url: "/agents/a1" })).toBe("/agents/a1");
    expect(notificationUrl({ url: "https://evil.example" })).toBe("/");
    expect(notificationUrl(undefined)).toBe("/");
  });
});

describe("resolveClickTarget", () => {
  it("opens a new window when there is no pi-code window", () => {
    expect(resolveClickTarget([], "/agents/a1", ORIGIN)).toEqual({
      action: "open",
      url: `${ORIGIN}/agents/a1`,
    });
    expect(
      resolveClickTarget([{ url: "https://other.example/", focused: true }], "/agents/a1", ORIGIN),
    ).toEqual({ action: "open", url: `${ORIGIN}/agents/a1` });
  });

  it("focuses a window already on the URL without navigating", () => {
    const clients = [
      { url: `${ORIGIN}/`, focused: true },
      { url: `${ORIGIN}/agents/a1`, focused: false },
    ];
    expect(resolveClickTarget(clients, "/agents/a1", ORIGIN)).toEqual({
      action: "focus",
      index: 1,
      url: `${ORIGIN}/agents/a1`,
      navigate: false,
    });
  });

  it("prefers the focused window, else the first one, and navigates it", () => {
    const clients = [
      { url: `${ORIGIN}/sessions`, focused: false },
      { url: `${ORIGIN}/agents/b2`, focused: true },
    ];
    expect(resolveClickTarget(clients, "/agents/a1", ORIGIN)).toMatchObject({
      action: "focus",
      index: 1,
      navigate: true,
    });
    expect(
      resolveClickTarget([{ url: `${ORIGIN}/sessions`, focused: false }], "/agents/a1", ORIGIN),
    ).toMatchObject({ action: "focus", index: 0, navigate: true });
  });
});

describe("messages", () => {
  it("recognizes SW messages", () => {
    expect(isSwMessage({ type: SW_MESSAGE.navigate, url: "/agents/a1" })).toBe(true);
    expect(isSwMessage({ type: SW_MESSAGE.push, payload })).toBe(true);
    expect(isSwMessage({ type: SW_MESSAGE.navigate })).toBe(false);
    expect(isSwMessage({ type: "other" })).toBe(false);
    expect(isSwMessage(null)).toBe(false);
  });

  it("safeAppPath", () => {
    expect(safeAppPath("/x")).toBe("/x");
    expect(safeAppPath("x")).toBe("/");
    expect(safeAppPath(undefined, "a1")).toBe("/agents/a1");
  });
});
