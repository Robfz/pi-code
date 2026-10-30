/**
 * The `theme-color` meta, which tints an installed app's title bar (and, under Window Controls
 * Overlay, the window controls' area beside the header), kept on `--surface-chrome`, the headers'
 * surface, as the theme (`.dark`) and palette (`data-palette`) on <html> change. Watching <html>
 * instead of the stores catches every change after it's applied, whoever applies it.
 * Before the app starts the meta keeps `index.html`'s static colour.
 */

/** Starts syncing; returns a stop function. Does nothing without the meta. */
export function syncThemeColor(): () => void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return () => {};
  const update = () => {
    const chrome = getComputedStyle(document.documentElement).getPropertyValue("--surface-chrome");
    meta.content = toHex(chrome.trim());
  };
  update();
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-palette"],
  });
  const stopResend = resendAfterFirstPaint(meta, update);
  return () => {
    observer.disconnect();
    stopResend();
  };
}

/**
 * Sends the colour again once the page has painted. Chromium drops theme-colour changes made
 * before a page's first paint and, at that paint, sends the colour only if it differs from the
 * last one it sent, which after a reload is the same colour from the previous page. Meanwhile the
 * reload showed the static colour, which would stay until the next change. Clearing the meta for
 * a frame and then setting it makes two changes Chromium can't skip.
 */
function resendAfterFirstPaint(meta: HTMLMetaElement, update: () => void): () => void {
  if (!globalThis.PerformanceObserver?.supportedEntryTypes?.includes("paint")) return () => {};
  let frame = 0;
  const observer = new PerformanceObserver((list) => {
    if (!list.getEntriesByName("first-contentful-paint").length) return;
    observer.disconnect();
    meta.removeAttribute("content");
    frame = requestAnimationFrame(update);
  });
  observer.observe({ type: "paint", buffered: true });
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
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
