import { PanelLeftIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Sidebar } from "./sidebar";

/** Below the desktop breakpoint: the sidebar in a left sheet, closed once something is picked. */
export function SidebarSheet() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="icon" aria-label="Conversations" onClick={() => setOpen(true)}>
        <PanelLeftIcon />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="gap-0 pt-[env(safe-area-inset-top)] [--titlebar-right:calc(100vw-min(85vw,20rem))] data-[side=left]:w-[min(85vw,20rem)]"
        >
          <SheetTitle className="sr-only">Conversations</SheetTitle>
          <SheetDescription className="sr-only">
            Switch, start or resume a conversation.
          </SheetDescription>
          <Sidebar
            onSelect={() => setOpen(false)}
            action={
              <SheetClose asChild>
                <Button variant="ghost" size="icon" aria-label="Close conversations">
                  <XIcon />
                </Button>
              </SheetClose>
            }
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
