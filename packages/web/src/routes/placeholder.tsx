import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useIsDesktop } from "@/lib/use-media-query";

/** A screen's top bar, like the conversation header: full width, bottom border, 48px row. */
export function ScreenHeader({ children }: { children: ReactNode }) {
  return (
    <header className="flex shrink-0 items-center border-b bg-background/95 px-2 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="flex h-12 min-w-0 flex-1 items-center gap-1">{children}</div>
    </header>
  );
}

/**
 * Simple screen shell: header with a back-to-Home button (phones only; desktop has the sidebar)
 * and title, then content (defaults to "Coming soon.").
 */
export function PlaceholderScreen({
  title,
  back,
  children,
}: {
  title: string;
  back?: ReactNode;
  children?: ReactNode;
}) {
  const desktop = useIsDesktop();
  return (
    <div className="flex min-h-dvh w-full flex-col">
      <ScreenHeader>
        {back ??
          (!desktop && (
            <Button variant="ghost" size="icon" asChild>
              <Link to="/" aria-label="Home">
                <ChevronLeftIcon />
              </Link>
            </Button>
          ))}
        <h1 className="truncate text-sm font-medium">{title}</h1>
      </ScreenHeader>
      <div className="mx-auto w-full max-w-2xl px-4 pt-4 text-sm text-muted-foreground">
        {children ?? "Coming soon."}
      </div>
    </div>
  );
}
