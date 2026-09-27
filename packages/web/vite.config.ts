/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/** Dark theme background (`--background` in `src/index.css`). */
const THEME_COLOR = "#0a0a0a";

/** Lazy Shiki chunks (grammars, themes, engine) go to their own folder, outside the precache. */
const SHIKI_DIR = "shiki";
const SHIKI_MODULE = /[\\/]node_modules[\\/](?:shiki|@shikijs|@streamdown[\\/]code)[\\/]/;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false,
      // The glob below already precaches the icons.
      includeManifestIcons: false,
      manifest: {
        id: "/",
        name: "pi-code",
        short_name: "pi-code",
        description: "Drive the pi coding agent on your Mac from your phone.",
        start_url: "/",
        scope: "/",
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
        share_target: {
          action: "/share",
          method: "GET",
          params: { title: "title", text: "text", url: "url" },
        },
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // Shiki's grammars and themes (hundreds of lazy chunks) load on demand, not at install.
        globIgnores: [`**/${SHIKI_DIR}/**`],
      },
    }),
  ],
  build: {
    rolldownOptions: {
      output: {
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
});
