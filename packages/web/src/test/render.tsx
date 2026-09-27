import type { Snapshot } from "@pi-code/protocol";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { createQueryClient } from "@/lib/query-client";
import { ConversationStoreProvider } from "@/store/context";
import { type ConversationStore, createConversationStore } from "@/store/conversation-store";
import { makeSnapshot } from "./fixtures";

/** A hydrated store (no connection). */
export function hydratedStore(patch: Partial<Snapshot> = {}): ConversationStore {
  const snapshot = makeSnapshot(patch);
  const store = createConversationStore(snapshot.agent.id);
  store.getState().hydrate(snapshot);
  store.getState().setConnection("live");
  return store;
}

/** Render inside a store provider and a minimal router (for `Link` / `useNavigate`). */
export async function renderWithStore(ui: ReactNode, store: ConversationStore) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <ConversationStoreProvider store={store}>{ui}</ConversationStoreProvider>
      </QueryClientProvider>
    ),
  });
  const catchAll = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([catchAll]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const result = render(<RouterProvider router={router as never} />);
  return { ...result, router, queryClient };
}

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Stub `fetch`: records calls; `handler` returns `[status, body]` per request (default 200 `{}`).
 */
export function stubFetch(
  handler: (call: FetchCall) => [number, unknown] | undefined = () => undefined,
) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    let body: unknown;
    const raw = init?.body ?? undefined;
    if (typeof raw === "string") body = JSON.parse(raw);
    const call = { url: new URL(url, "http://localhost:3000").pathname, method, body };
    calls.push(call);
    const [status, payload] = handler(call) ?? [200, {}];
    return new Response(status === 204 ? null : JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}
