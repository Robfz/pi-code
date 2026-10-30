/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type Rolldown } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import {
  ICON_VARIANTS,
  type IconVariant,
  isIconVariant,
  renderAppIcons,
} from "./scripts/app-icons.ts";
import { isLazyAsset, SHIKI_DIR } from "./src/sw/lazy-assets.ts";

/** Dark theme background (`--background` in `src/index.css`). */
const THEME_COLOR = "#0d0d0d";

/** Lazy Shiki chunks (grammars, themes, engine) go to their own folder, outside the precache. */
const SHIKI_MODULE = /[\\/]node_modules[\\/](?:shiki|@shikijs)[\\/]/;

/**
 * Third-party code in chunks of its own, so a deploy that changes only the app keeps their hashes
 * (and the browser and service worker caches of them). A group takes its modules' dependencies
 * along; React's priority keeps it out of the libraries built on it.
 */
const VENDOR_CHUNKS: Rolldown.CodeSplittingGroup[] = [
  { name: "react", test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 1 },
  {
    name: "radix",
    test: /[\\/]node_modules[\\/](?:radix-ui|@radix-ui[\\/][^\\/]+)[\\/]/,
  },
  { name: "tanstack", test: /[\\/]node_modules[\\/]@tanstack[\\/]/ },
  // Streamdown's renderer and the markdown pipeline it imports. `$initial` keeps out its lazy
  // modules (code highlighting, Mermaid), whose Shiki-only dependencies would follow them in.
  { name: "markdown", test: /[\\/]node_modules[\\/]streamdown[\\/]/, tags: ["$initial"] },
];

/**
 * Per-instance build options, from the environment or the repo root's `.env.local` (one install
 * per host, each its own installable app):
 * - `PI_CODE_INSTANCE`: name shown after "pi-code" (`pi-code - M3`); alone as the short name.
 * - `PI_CODE_ICON`: icon variant, `dark` (default) or `light`.
 */
function instanceOptions(mode: string): { name: string; shortName: string; icon: IconVariant } {
  const env = loadEnv(mode, fileURLToPath(new URL("../..", import.meta.url)), "PI_CODE_");
  const instance = env.PI_CODE_INSTANCE?.trim();
  const icon = env.PI_CODE_ICON?.trim() || "dark";
  if (!isIconVariant(icon)) {
    throw new Error(`PI_CODE_ICON must be one of ${ICON_VARIANTS.join(", ")} (got "${icon}")`);
  }
  return instance
    ? { name: `pi-code - ${instance}`, shortName: instance, icon }
    : { name: "pi-code", shortName: "pi-code", icon };
}

/** Serves the generated icons in dev and writes them into the build, at the paths the manifest uses. */
function appIcons(variant: IconVariant): Plugin {
  let files: Map<string, Uint8Array | string> | undefined;
  const icons = () => {
    files ??= renderAppIcons(variant);
    return files;
  };
  return {
    name: "pi-code:app-icons",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname.slice(1);
        const source = icons().get(path);
        if (source === undefined) return next();
        res.setHeader("Content-Type", path.endsWith(".svg") ? "image/svg+xml" : "image/png");
        res.end(source);
      });
    },
    generateBundle() {
      for (const [fileName, source] of icons()) this.emitFile({ type: "asset", fileName, source });
    },
  };
}

/** Fills the app name into `index.html`'s `%APP_NAME%` and `%APP_SHORT_NAME%`. */
function appName(name: string, shortName: string): Plugin {
  return {
    name: "pi-code:app-name",
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html.replaceAll("%APP_NAME%", name).replaceAll("%APP_SHORT_NAME%", shortName),
    },
  };
}

export default defineConfig(({ mode }) => {
  const instance = instanceOptions(mode);
  return {
    define: {
      __APP_NAME__: JSON.stringify(instance.name),
    },
    plugins: [
      react(),
      tailwindcss(),
      appIcons(instance.icon),
      appName(instance.name, instance.shortName),
      VitePWA({
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
        injectRegister: false,
        // The glob below already precaches the icons (written by `appIcons`).
        includeManifestIcons: false,
        manifest: {
          id: "/",
          name: instance.name,
          short_name: instance.shortName,
          description: "A client for the pi coding agent running on your Mac.",
          start_url: "/",
          scope: "/",
          // The title bar's space goes to the app's top row (`titlebar` in `src/index.css`).
          display_override: ["window-controls-overlay"],
          display: "standalone",
          orientation: "any",
          theme_color: THEME_COLOR,
          background_color: THEME_COLOR,
          categories: ["developer", "productivity"],
          icons: [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            {
              src: "/icons/maskable-192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "maskable",
            },
            {
              src: "/icons/maskable-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
            { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
          ],
          launch_handler: { client_mode: "focus-existing" },
          shortcuts: [
            {
              name: "New conversation",
              short_name: "New",
              url: "/?new=1",
              icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
            },
          ],
          share_target: {
            action: "/share",
            method: "GET",
            params: { title: "title", text: "text", url: "url" },
          },
        },
        injectManifest: {
          globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
          // Cached on first use by the service worker instead.
          manifestTransforms: [
            (entries) => ({ manifest: entries.filter((entry) => !isLazyAsset(entry.url)) }),
          ],
        },
      }),
    ],
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: { groups: VENDOR_CHUNKS },
          chunkFileNames: (chunk) =>
            chunk.moduleIds.some((id) => SHIKI_MODULE.test(id))
              ? `assets/${SHIKI_DIR}/[name]-[hash].js`
              : "assets/[name]-[hash].js",
        },
      },
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      proxy: {
        "/api": "http://127.0.0.1:4180",
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
    },
  };
});
