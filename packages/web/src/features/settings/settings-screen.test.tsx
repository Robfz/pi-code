import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "@/App";
import { urlBase64ToUint8Array } from "@/lib/push";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";
import { useUiPrefs } from "@/store/ui-prefs";
import { installPushEnv, uninstallPushEnv } from "@/test/push-env";
import { stubFetch } from "@/test/render";

// 65 bytes, like a P-256 public key (base64url, no padding).
const VAPID_KEY = btoa(String.fromCharCode(...Array.from({ length: 65 }, (_, i) => i + 1)))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

function renderSettings() {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

function stubPushApi() {
  return stubFetch((call) => {
    if (call.url === "/api/push/vapid-key") return [200, { publicKey: VAPID_KEY }];
    if (call.url === "/api/push/subscriptions") return [204, null];
    if (call.url === "/api/health") return [200, { ok: true, piVersion: "0.87.1" }];
    return undefined;
  });
}

afterEach(() => {
  uninstallPushEnv();
});

describe("urlBase64ToUint8Array", () => {
  it("decodes base64url without padding", () => {
    const bytes = urlBase64ToUint8Array(VAPID_KEY);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(1);
    expect(bytes[64]).toBe(65);
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([0xfb, 0xff]);
  });
});

describe("Settings · notifications", () => {
  it("reports unsupported browsers", async () => {
    stubPushApi();
    renderSettings();
    expect(await screen.findByTestId("push-state")).toHaveTextContent("Unsupported");
    expect(screen.getByText(/add pi-code to the Home Screen/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Enable notifications/ })).toBeNull();
  });

  it("reports blocked notifications", async () => {
    stubPushApi();
    installPushEnv({ permission: "denied" });
    renderSettings();
    expect(await screen.findByTestId("push-state")).toHaveTextContent("Blocked");
    expect(screen.queryByRole("button", { name: /Enable notifications/ })).toBeNull();
  });

  it("enables: permission → subscribe with the VAPID key → upload; then disables", async () => {
    const { calls } = stubPushApi();
    const env = installPushEnv();
    renderSettings();
    const user = userEvent.setup();
    expect(await screen.findByTestId("push-state")).toHaveTextContent("Off");

    await user.click(screen.getByRole("button", { name: "Enable notifications" }));
    await waitFor(() => expect(screen.getByTestId("push-state")).toHaveTextContent("Enabled"));
    expect(env.Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(env.pushManager.subscribe).toHaveBeenCalledTimes(1);
    const options = env.pushManager.subscribe.mock.calls[0]?.[0] as PushSubscriptionOptionsInit;
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(options.applicationServerKey as Uint8Array)).toEqual(
      Array.from(urlBase64ToUint8Array(VAPID_KEY)),
    );
    const upload = calls.find((c) => c.url === "/api/push/subscriptions" && c.method === "POST");
    expect(upload?.body).toEqual({
      endpoint: "https://push.example/sub-1",
      keys: { p256dh: "p256", auth: "auth" },
    });

    const subscription = env.current();
    await user.click(screen.getByRole("button", { name: "Disable notifications" }));
    await waitFor(() => expect(screen.getByTestId("push-state")).toHaveTextContent("Off"));
    expect(subscription?.unsubscribe).toHaveBeenCalledTimes(1);
    const removal = calls.find((c) => c.url === "/api/push/subscriptions" && c.method === "DELETE");
    expect(removal?.body).toEqual({ endpoint: "https://push.example/sub-1" });
  });

  it("stops when the permission prompt is denied", async () => {
    const { calls } = stubPushApi();
    const env = installPushEnv({ requestResult: "denied" });
    renderSettings();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Enable notifications" }));
    await waitFor(() => expect(screen.getByTestId("push-state")).toHaveTextContent("Blocked"));
    expect(env.pushManager.subscribe).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url === "/api/push/subscriptions")).toBe(false);
  });

  it("replaces a subscription made with another server key", async () => {
    stubPushApi();
    // A leftover subscription (e.g. permission was reset, or the server's VAPID key rotated).
    const env = installPushEnv({ permission: "default", subscribedKey: new Uint8Array([9, 9]) });
    const old = env.current();
    renderSettings();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Enable notifications" }));
    await waitFor(() => expect(screen.getByTestId("push-state")).toHaveTextContent("Enabled"));
    expect(old?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(env.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(env.current()?.endpoint).toBe("https://push.example/sub-2");
  });

  it("keeps a subscription made with the same key", async () => {
    const { calls } = stubPushApi();
    const env = installPushEnv({
      permission: "default",
      subscribedKey: urlBase64ToUint8Array(VAPID_KEY),
    });
    renderSettings();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Enable notifications" }));
    await waitFor(() => expect(screen.getByTestId("push-state")).toHaveTextContent("Enabled"));
    expect(env.pushManager.subscribe).not.toHaveBeenCalled();
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      endpoint: "https://push.example/sub-1",
    });
  });

  it("toasts upload failures (ApiError message)", async () => {
    stubFetch((call) => {
      if (call.url === "/api/push/vapid-key") return [200, { publicKey: VAPID_KEY }];
      if (call.url === "/api/push/subscriptions") {
        return [500, { error: { code: "internal", message: "push store unavailable" } }];
      }
      return undefined;
    });
    installPushEnv();
    renderSettings();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Enable notifications" }));
    expect(await screen.findByText("push store unavailable")).toBeInTheDocument();
    expect(screen.getByTestId("push-state")).toHaveTextContent("Off");
  });

  it("shows the server's pi version", async () => {
    stubPushApi();
    renderSettings();
    expect(await screen.findByText("0.87.1")).toBeInTheDocument();
  });
});

describe("Settings · theme", () => {
  it("marks the active theme as pressed", async () => {
    stubPushApi();
    renderSettings();
    const user = userEvent.setup();
    const dark = await screen.findByRole("button", { name: "Dark" });
    await user.click(dark);
    await waitFor(() => expect(dark).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "System" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "System" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });
});

describe("Settings · palette", () => {
  it("applies the chosen palette to the page", async () => {
    stubPushApi();
    useUiPrefs.setState({ palette: "neutral" });
    renderSettings();
    const user = userEvent.setup();
    const neutral = await screen.findByRole("button", { name: "Neutral" });
    expect(neutral).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.dataset.palette).toBe("neutral");
    const deco = screen.getByRole("button", { name: "Deco" });
    await user.click(deco);
    expect(deco).toHaveAttribute("aria-pressed", "true");
    expect(neutral).toHaveAttribute("aria-pressed", "false");
    expect(useUiPrefs.getState().palette).toBe("deco");
    expect(document.documentElement.dataset.palette).toBe("deco");
    // Each swatch reads its colours from its own palette's scope.
    expect(deco.querySelector('[data-palette="deco"]')).not.toBeNull();
  });
});

describe("Settings · transcript density", () => {
  it("offers the three densities, the current one pressed", async () => {
    stubPushApi();
    useUiPrefs.setState({ density: "balanced" });
    renderSettings();
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Transcript density" })).toBeInTheDocument();
    const pressed = () =>
      ["Compact", "Balanced", "Detailed"].map((name) =>
        screen.getByRole("button", { name }).getAttribute("aria-pressed"),
      );
    expect(pressed()).toEqual(["false", "true", "false"]);
    await user.click(screen.getByRole("button", { name: "Compact" }));
    expect(useUiPrefs.getState().density).toBe("compact");
    expect(pressed()).toEqual(["true", "false", "false"]);
    await user.click(screen.getByRole("button", { name: "Detailed" }));
    expect(pressed()).toEqual(["false", "false", "true"]);
  });
});

describe("Settings · diff text size", () => {
  it("offers the sizes, the current one pressed", async () => {
    stubPushApi();
    useUiPrefs.setState({ diffFontSize: 12 });
    renderSettings();
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Diff text size" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "12px" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "16px" }));
    expect(useUiPrefs.getState().diffFontSize).toBe(16);
    expect(screen.getByRole("button", { name: "16px" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "12px" })).toHaveAttribute("aria-pressed", "false");
  });
});
