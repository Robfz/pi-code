import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";

type AppRouter = ReturnType<typeof createAppRouter>;

/** Providers (theme, query, router, toasts). Tests pass their own router / query client. */
export function App({ router, queryClient }: { router?: AppRouter; queryClient?: QueryClient }) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const [appRouter] = useState(() => router ?? createAppRouter());
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <RouterProvider router={appRouter} />
          <Toaster position="top-center" closeButton />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
