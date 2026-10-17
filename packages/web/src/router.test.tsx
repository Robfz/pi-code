import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { createQueryClient } from "./lib/query-client.ts";
import { createAppRouter } from "./router.tsx";
import { makeAgent, makeSnapshot } from "./test/fixtures.ts";
import { stubFetch } from "./test/render.tsx";

function renderAt(path: string) {
  stubFetch((call) =>
    call.url === "/api/agents/a1/snapshot"
      ? [200, makeSnapshot({ agent: makeAgent({ id: "a1", cwd: "/home/me/alpha" }) })]
      : undefined,
  );
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("routes", () => {
  it.each([
    ["/", "pi-code"],
    ["/sessions", "Sessions"],
    ["/settings", "Settings"],
    ["/share", "Send to…"],
    ["/agents/a1", "New conversation"],
    ["/agents/a1/tree", "Session tree"],
  ])("%s renders its screen", async (path, heading) => {
    renderAt(path);
    expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeInTheDocument();
  });

  it("/sessions passes the project filter to the screen", async () => {
    renderAt("/sessions?cwd=%2Fhome%2Fme%2Falpha");
    expect(await screen.findByRole("combobox", { name: "Project" })).toHaveValue("/home/me/alpha");
  });

  it("/agents/$agentId/diff renders the review page on phones", async () => {
    renderAt("/agents/a1/diff");
    expect(await screen.findByRole("link", { name: "Back to conversation" })).toHaveAttribute(
      "href",
      "/agents/a1",
    );
  });
});
