/**
 * Code-based route tree (`docs/design/03-web-client.md`, "Routes").
 *
 * `/agents/$agentId` is a layout owning the agent's store and connection; the conversation,
 * tree and diff screens are its children, so switching between them keeps the live state.
 */

import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
} from "@tanstack/react-router";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { SessionsScreen } from "@/features/catalog/sessions-screen";
import { ConversationRoot } from "@/features/conversation/conversation-root";
import { ConversationScreen } from "@/features/conversation/conversation-screen";
import { DiffScreen } from "@/features/diff/diff-screen";
import { TreeScreen } from "@/features/tree/tree-screen";
import { HomeScreen } from "@/routes/home";
import { PlaceholderScreen } from "@/routes/placeholder";

const rootRoute = createRootRoute({
  component: () => (
    <div className="min-h-dvh bg-background text-foreground">
      <Outlet />
    </div>
  ),
  notFoundComponent: () => <PlaceholderScreen title="Not found">No such page.</PlaceholderScreen>,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeScreen,
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

const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/share",
  validateSearch: (
    search: Record<string, unknown>,
  ): { title?: string; text?: string; url?: string } => {
    const out: { title?: string; text?: string; url?: string } = {};
    for (const key of ["title", "text", "url"] as const) {
      const value = search[key];
      if (typeof value === "string") out[key] = value;
    }
    return out;
  },
  component: () => <PlaceholderScreen title="Send to…" />,
});

function SettingsScreen() {
  const { theme, setTheme } = useTheme();
  return (
    <PlaceholderScreen title="Settings">
      <section className="flex flex-col gap-2">
        <h2 className="font-medium text-foreground">Theme</h2>
        <div className="flex gap-2">
          {(["system", "dark", "light"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={theme === option ? "default" : "outline"}
              onClick={() => setTheme(option)}
            >
              {option[0]?.toUpperCase()}
              {option.slice(1)}
            </Button>
          ))}
        </div>
      </section>
    </PlaceholderScreen>
  );
}

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
