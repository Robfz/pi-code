/**
 * Code-based route tree (`docs/design/03-web-client.md`, "Routes").
 *
 * `/agents/$agentId` is a layout providing the agent's store from the live registry; the
 * conversation, tree and diff screens are its children.
 *
 * Home and the conversation, the screens a cold start opens, are in the entry chunk; the other
 * screens load on first visit (or on hovering a link to them, `defaultPreload: "intent"`).
 */

import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router";
import { LoaderIcon } from "lucide-react";
import { ConversationRoot } from "@/features/conversation/conversation-root";
import { ConversationScreen } from "@/features/conversation/conversation-screen";
import { AppShell } from "@/features/pwa/app-shell";
import { IndexScreen } from "@/routes/index";
import { PlaceholderScreen } from "@/routes/placeholder";

/** Shown in place of a screen whose chunk takes longer than the router's `pendingMs` to load. */
function ScreenLoading() {
  return (
    <div className="flex min-h-dvh w-full items-center justify-center">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderIcon className="size-4 animate-spin" /> Loading…
      </p>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
  notFoundComponent: () => <PlaceholderScreen title="Not found">No such page.</PlaceholderScreen>,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>): { new?: true } =>
    search.new === undefined ? {} : { new: true },
  component: IndexScreen,
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  validateSearch: (search: Record<string, unknown>): { cwd?: string } =>
    typeof search.cwd === "string" ? { cwd: search.cwd } : {},
  component: lazyRouteComponent(async () => {
    const { SessionsScreen } = await import("@/features/catalog/sessions-screen");
    return {
      default: function SessionsRoute() {
        const { cwd } = sessionsRoute.useSearch();
        return <SessionsScreen {...(cwd ? { cwd } : {})} />;
      },
    };
  }),
});

const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/$agentId",
  component: function AgentLayout() {
    const { agentId } = agentRoute.useParams();
    return (
      <ConversationRoot key={agentId} agentId={agentId}>
        <Outlet />
      </ConversationRoot>
    );
  },
});

const conversationRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "/",
  component: ConversationScreen,
});

const treeRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "/tree",
  component: lazyRouteComponent(() => import("@/features/tree/tree-screen"), "TreeScreen"),
});

const diffRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "/diff",
  component: lazyRouteComponent(() => import("@/features/diff/diff-screen"), "DiffScreen"),
});

/** Share target (`?title&text&url`); the screen reads the raw query string itself. */
const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/share",
  component: lazyRouteComponent(() => import("@/features/share/share-screen"), "ShareScreen"),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: lazyRouteComponent(
    () => import("@/features/settings/settings-screen"),
    "SettingsScreen",
  ),
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  sessionsRoute,
  agentRoute.addChildren([conversationRoute, treeRoute, diffRoute]),
  shareRoute,
  settingsRoute,
]);

export function createAppRouter(options: { history?: RouterHistory } = {}) {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    defaultPendingComponent: ScreenLoading,
    scrollRestoration: true,
    ...(options.history ? { history: options.history } : {}),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
