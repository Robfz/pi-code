/**
 * The `theme-color` meta, which tints an installed app's title bar, kept on the page's
 * `--background` as the theme (`.dark`) and palette (`data-palette`) on <html> change. Watching
 * <html> instead of the stores catches every change after it's applied, whoever applies it.
 * Before the app starts the meta keeps `index.html`'s static colour.
 */

/** Starts syncing; returns a stop function. Does nothing without the meta. */
export function syncThemeColor(): () => void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return () => {};
  const update = () => {
    meta.content = toHex(getComputedStyle(document.body).backgroundColor);
  };
  update();
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-palette"],
  });
  return () => observer.disconnect();
}

/**
 * The colour as sRGB hex. Computed styles keep the palettes' `oklch()`, which title bars may not
 * parse; a canvas pixel converts it. Without a canvas the colour passes through unchanged.
 */
function toHex(color: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return color;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
