/**
 * Code-based route tree (`docs/design/03-web-client.md`, "Routes").
 *
 * `/agents/$agentId` is a layout providing the agent's store from the live registry; the
 * conversation, tree and diff screens are its children.
 */

import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router";
import { SessionsScreen } from "@/features/catalog/sessions-screen";
import { ConversationRoot } from "@/features/conversation/conversation-root";
import { ConversationScreen } from "@/features/conversation/conversation-screen";
import { DiffScreen } from "@/features/diff/diff-screen";
import { AppShell } from "@/features/pwa/app-shell";
import { SettingsScreen } from "@/features/settings/settings-screen";
import { ShareScreen } from "@/features/share/share-screen";
import { TreeScreen } from "@/features/tree/tree-screen";
import { IndexScreen } from "@/routes/index";
import { PlaceholderScreen } from "@/routes/placeholder";

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
  component: function SessionsRoute() {
    const { cwd } = sessionsRoute.useSearch();
    return <SessionsScreen {...(cwd ? { cwd } : {})} />;
  },
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
  component: TreeScreen,
});

const diffRoute = createRoute({
  getParentRoute: () => agentRoute,
  path: "/diff",
  component: DiffScreen,
});

/** Share target (`?title&text&url`); the screen reads the raw query string itself. */
const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/share",
  component: ShareScreen,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsScreen,
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
    scrollRestoration: true,
    ...(options.history ? { history: options.history } : {}),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
