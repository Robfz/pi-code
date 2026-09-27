import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Simple screen shell: back-to-Home button, title, content (defaults to "Coming soon."). */
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
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 px-2 pt-[env(safe-area-inset-top)]">
      <header className="flex h-12 items-center gap-1">
        {back ?? (
          <Button variant="ghost" size="icon" asChild>
            <Link to="/" aria-label="Home">
              <ChevronLeftIcon />
            </Link>
          </Button>
        )}
        <h1 className="text-sm font-medium">{title}</h1>
      </header>
      <div className="px-2 text-sm text-muted-foreground">{children ?? "Coming soon."}</div>
    </div>
  );
}
