/**
 * Built assets the service worker leaves out of its precache and caches on first use instead
 * (`sw.ts`), so installs and updates don't download what most sessions never load: Shiki's
 * grammars and themes (hundreds of chunks, in `SHIKI_DIR`), the diff viewer's chunk (highlight.js
 * through lowlight, about 1 MB, and its CSS), and the Geist subsets beyond basic Latin (the
 * browser fetches a subset only when the page shows one of its characters).
 */

/** Folder of the lazy Shiki chunks under `assets/` (`vite.config.ts`). */
export const SHIKI_DIR = "shiki";

const LAZY_CHUNK = new RegExp(`(?:^|/)assets/(?:${SHIKI_DIR}/|diff-view-impl-)`);
const LATIN_FONT = /(?:^|\/)geist(?:-mono)?-latin-wght-[^/]+\.woff2$/;

/** Whether the asset at `path` (a URL path, or a path relative to the build dir) is lazy. */
export function isLazyAsset(path: string): boolean {
  return LAZY_CHUNK.test(path) || (path.endsWith(".woff2") && !LATIN_FONT.test(path));
}
