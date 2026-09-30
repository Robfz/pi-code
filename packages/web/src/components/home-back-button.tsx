import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsDesktop } from "@/lib/use-media-query";

/** A header's back-to-Home chevron; nothing on desktop, where the sidebar is the way back. */
export function HomeBackButton() {
  const desktop = useIsDesktop();
  if (desktop) return null;
  return (
    <Button variant="ghost" size="icon" asChild>
      <Link to="/" aria-label="Home">
        <ChevronLeftIcon />
      </Link>
    </Button>
  );
}
