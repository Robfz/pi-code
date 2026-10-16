/**
 * Colour palettes (`docs/design/09-ui-overhaul.md`, "Palettes"), independent of the light / dark
 * theme. Their tokens live in `index.css` (neutral) and `palettes.css`, keyed by `data-palette`;
 * `index.html` sets the saved one on <html> before first paint.
 */
export type Palette =
  | "neutral"
  | "macos"
  | "catppuccin"
  | "nord"
  | "tokyo-night"
  | "abyss"
  | "aurora"
  | "sumi"
  | "sakura";

export const PALETTES: readonly Palette[] = [
  "neutral",
  "macos",
  "catppuccin",
  "nord",
  "tokyo-night",
  "abyss",
  "aurora",
  "sumi",
  "sakura",
];

export const PALETTE_LABEL: Record<Palette, string> = {
  neutral: "Neutral",
  macos: "macOS",
  catppuccin: "Catppuccin",
  nord: "Nord",
  "tokyo-night": "Tokyo Night",
  abyss: "Abyss",
  aurora: "Aurora",
  sumi: "Sumi",
  sakura: "Sakura",
};
