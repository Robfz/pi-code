import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** `text-prose` is a font size (`index.css`), not a colour, so `text-xs` replaces it. */
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["prose"] } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
