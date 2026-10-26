import type { ReactNode } from "react";
import { HomeBackButton } from "@/components/home-back-button";
import { cn } from "@/lib/utils";

/**
 * A screen's top bar, like the conversation header: full width, bottom border, 48px row; the
 * title bar under Window Controls Overlay (`titlebar`).
 */
export function ScreenHeader({ children }: { children: ReactNode }) {
  return (
    <header className="titlebar box-content flex h-12 min-w-0 shrink-0 items-center gap-1 border-b bg-surface-chrome px-2 pt-[env(safe-area-inset-top)]">
      {children}
    </header>
  );
}

/**
 * Simple screen shell: header with a back-to-Home button (phones only; desktop has the sidebar)
 * and title, then content (defaults to "Coming soon."). `centered` centers the content in the
 * space below the header, for a lone empty state.
 */
export function PlaceholderScreen({
  title,
  back,
  centered = false,
  children,
}: {
  title: string;
  back?: ReactNode;
  centered?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh w-full flex-col">
      <ScreenHeader>
        {back ?? <HomeBackButton />}
        <h1 className="truncate text-sm font-medium">{title}</h1>
      </ScreenHeader>
      <div
        className={cn(
          "mx-auto w-full max-w-2xl px-4 text-sm text-muted-foreground",
          centered ? "flex flex-1 flex-col items-center justify-center pb-12" : "pt-4",
        )}
      >
        {children ?? "Coming soon."}
      </div>
    </div>
  );
}
