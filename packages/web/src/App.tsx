import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";
import { LiveRegistryProvider } from "@/store/context";
import { LiveRegistry } from "@/store/live-registry";
import { useUiPrefs } from "@/store/ui-prefs";

type AppRouter = ReturnType<typeof createAppRouter>;

const BOTTOM_TOAST_OFFSET = "calc(9rem + env(safe-area-inset-bottom))";

/** The chosen palette on <html>, a component of its own so a change re-renders nothing else. */
function PaletteAttribute() {
  const palette = useUiPrefs((s) => s.palette);
  useEffect(() => {
    document.documentElement.dataset.palette = palette;
  }, [palette]);
  return null;
}

/**
 * Providers (theme, query, live registry, router, toasts) and the palette. Tests pass their own
 * router / query client.
 */
export function App({ router, queryClient }: { router?: AppRouter; queryClient?: QueryClient }) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const [appRouter] = useState(() => router ?? createAppRouter());
  const [registry] = useState(() => new LiveRegistry(client));
  useEffect(() => {
    registry.start();
    return () => registry.stop();
  }, [registry]);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <PaletteAttribute />
      <QueryClientProvider client={client}>
        <LiveRegistryProvider registry={registry}>
          <TooltipProvider>
            <RouterProvider router={appRouter} />
            <Toaster
              position="top-center"
              closeButton
              // Bottom toasts (the update prompt) clear the composer and status bar.
              offset={{ bottom: BOTTOM_TOAST_OFFSET }}
              mobileOffset={{ bottom: BOTTOM_TOAST_OFFSET }}
            />
          </TooltipProvider>
        </LiveRegistryProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
