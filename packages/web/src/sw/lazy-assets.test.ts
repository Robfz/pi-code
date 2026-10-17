import { describe, expect, it } from "vitest";
import { isLazyAsset } from "./lazy-assets.ts";

describe("isLazyAsset", () => {
  it.each([
    "assets/shiki/dist-CB_-Cqq8.js",
    "/assets/shiki/typescript-D1x2y3z4.js",
    "assets/diff-view-impl-a3onOcrG.js",
    "/assets/diff-view-impl-CEvlaxS0.css",
    "assets/geist-cyrillic-wght-normal-BEAKL7Jp.woff2",
    "/assets/geist-latin-ext-wght-normal-DC-KSUi6.woff2",
    "assets/geist-mono-vietnamese-wght-normal-DadHysG0.woff2",
    "assets/geist-mono-symbols2-wght-normal-CO5SzqOn.woff2",
  ])("leaves %s to the runtime cache", (path) => {
    expect(isLazyAsset(path)).toBe(true);
  });

  it.each([
    "index.html",
    "/assets/index-CzEFLe9B.js",
    "assets/index--IrTedyH.css",
    "assets/react-CR5VJ85Q.js",
    "assets/markdown-CInIidNs.js",
    "assets/settings-screen-Cq6VrfIp.js",
    "assets/diff-screen-DV-WH8dg.js",
    "/assets/geist-latin-wght-normal-BgDaEnEv.woff2",
    "assets/geist-mono-latin-wght-normal-XN7g48iV.woff2",
    "icons/icon-192.png",
  ])("precaches %s", (path) => {
    expect(isLazyAsset(path)).toBe(false);
  });
});
