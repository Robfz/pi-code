import type * as React from "react";
import { cn } from "@/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn("rounded border px-1 py-0.5 text-[11.5px] leading-none", className)}
      {...props}
    />
  );
}

export { Kbd };
