import type { ReactNode } from "react";
import { HomeBackButton } from "@/components/home-back-button";

/**
 * A screen's top bar, like the conversation header: full width, bottom border, 48px row; the
 * title bar under Window Controls Overlay (`titlebar`).
 */
export function ScreenHeader({ children }: { children: ReactNode }) {
  return (
    <header className="titlebar box-content flex h-12 min-w-0 shrink-0 items-center gap-1 border-b bg-background/95 px-2 pt-[env(safe-area-inset-top)] backdrop-blur">
      {children}
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
  return (
    <div className="flex min-h-dvh w-full flex-col">
      <ScreenHeader>
        {back ?? <HomeBackButton />}
        <h1 className="truncate text-sm font-medium">{title}</h1>
      </ScreenHeader>
      <div className="mx-auto w-full max-w-2xl px-4 pt-4 text-sm text-muted-foreground">
        {children ?? "Coming soon."}
      </div>
    </div>
  );
}
