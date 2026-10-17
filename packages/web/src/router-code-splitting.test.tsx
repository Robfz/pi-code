import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { createQueryClient } from "./lib/query-client.ts";
import { createAppRouter } from "./router.tsx";
import { stubFetch } from "./test/render.tsx";

/** Screen modules evaluated so far, and a gate holding the Settings module back. */
const modules = vi.hoisted(() => {
  let open: () => void = () => {};
  const settingsGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { loaded: new Set<string>(), settingsGate, openSettings: () => open() };
});

vi.mock("@/features/catalog/sessions-screen", async (original) => {
  modules.loaded.add("sessions");
  return original();
});
vi.mock("@/features/share/share-screen", async (original) => {
  modules.loaded.add("share");
  return original();
});
vi.mock("@/features/tree/tree-screen", async (original) => {
  modules.loaded.add("tree");
  return original();
});
vi.mock("@/features/diff/diff-screen", async (original) => {
  modules.loaded.add("diff");
  return original();
});
vi.mock("@/features/settings/settings-screen", async (original) => {
  modules.loaded.add("settings");
  await modules.settingsGate;
  return original();
});
vi.mock("@/features/conversation/conversation-screen", async (original) => {
  modules.loaded.add("conversation");
  return original();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("code splitting", () => {
  it("loads the conversation with the router and the other screens on first visit", async () => {
    // `router.tsx` is imported above: only the eager screens have been evaluated.
    expect([...modules.loaded]).toEqual(["conversation"]);

    stubFetch();
    const router = createAppRouter({
      history: createMemoryHistory({ initialEntries: ["/settings"] }),
    });
    render(<App router={router} queryClient={createQueryClient()} />);
    // A screen still loading after the router's `pendingMs` shows a loading state.
    expect(await screen.findByText("Loading…", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(modules.loaded).toContain("settings");
    expect(modules.loaded).not.toContain("sessions");

    modules.openSettings();
    expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});
