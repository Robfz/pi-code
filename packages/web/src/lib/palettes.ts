/**
 * Colour palettes (`docs/design/09-ui-overhaul.md`, "Palettes"), independent of the light / dark
 * theme. Their tokens live in `index.css` (neutral) and `palettes.css`, keyed by `data-palette`;
 * `index.html` sets the saved one on <html> before first paint.
 */
export type Palette =
  | "neutral"
  | "macos"
  | "catppuccin"
  | "rose-pine"
  | "nord"
  | "solarized"
  | "gruvbox"
  | "tokyo-night"
  | "everforest";

export const PALETTES: readonly Palette[] = [
  "neutral",
  "macos",
  "catppuccin",
  "rose-pine",
  "nord",
  "solarized",
  "gruvbox",
  "tokyo-night",
  "everforest",
];

export const PALETTE_LABEL: Record<Palette, string> = {
  neutral: "Neutral",
  macos: "macOS",
  catppuccin: "Catppuccin",
  "rose-pine": "Rosé Pine",
  nord: "Nord",
  solarized: "Solarized",
  gruvbox: "Gruvbox",
  "tokyo-night": "Tokyo Night",
  everforest: "Everforest",
};
