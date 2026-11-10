import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrGuide } from "@pi-code/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUIDE_VERSION } from "../pr/guide-format.ts";
import { GUIDES_DIR, GuideStore, guideKey } from "./guide-store.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function guide(headSha = HEAD): PrGuide {
  return {
    version: GUIDE_VERSION,
    repo: "octo/my_repo.js",
    number: 7,
    baseSha: BASE,
    headSha,
    sections: [{ title: "Core", explanation: "Why.", hunks: ["a.txt#1"] }],
    other: ["b.txt#1"],
  };
}

const keyOf = (g: PrGuide) => guideKey(g);

let dataDir: string;
let store: GuideStore;
const guidesDir = () => join(dataDir, GUIDES_DIR);

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "pi-code-guides-"));
  store = new GuideStore(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("guideKey", () => {
  it("names the PR diff", () => {
    expect(guideKey({ repo: "o/r", number: 3, baseSha: BASE, headSha: HEAD })).toBe(
      `o/r#3@${BASE}..${HEAD}`,
    );
    const parts = { repo: "o/r", number: 3, baseSha: BASE, headSha: HEAD };
    expect(guideKey({ ...parts, folder: "" })).toBe(`o/r#3@${BASE}..${HEAD}`);
    expect(guideKey({ ...parts, folder: "sub/" })).toBe(`o/r#3@${BASE}..${HEAD}:sub/`);
  });
});

describe("GuideStore", () => {
  it("reads nothing for an unknown key", async () => {
    expect(await store.read(keyOf(guide()))).toBeUndefined();
  });

  it("writes one file per key, named by its hash, and reads it back", async () => {
    const g = guide();
    await store.write(keyOf(g), g);
    expect(await store.read(keyOf(g))).toEqual({ state: "ready", guide: g });
    const names = readdirSync(guidesDir());
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(JSON.parse(readFileSync(join(guidesDir(), names[0] as string), "utf8"))).toEqual(g);
  });

  it("stores a guide whose key is longer than a file name may be", async () => {
    const g = { ...guide(), repo: `${"o".repeat(39)}/${"my_repo_".repeat(25)}`, number: 1234567 };
    expect(keyOf(g).length).toBeGreaterThan(255);
    await store.write(keyOf(g), g);
    expect(await store.read(keyOf(g))).toEqual({ state: "ready", guide: g });
  });

  it("overwrites a key's guide", async () => {
    const g = guide();
    await store.write(keyOf(g), g);
    const retried = { ...g, sections: [] };
    await store.write(keyOf(g), retried);
    expect(await store.read(keyOf(g))).toEqual({ state: "ready", guide: retried });
    expect(readdirSync(guidesDir())).toHaveLength(1);
  });

  it("reads another format version as outdated", async () => {
    const g = guide();
    await store.write(keyOf(g), { ...g, version: GUIDE_VERSION + 1 });
    expect(await store.read(keyOf(g))).toEqual({
      state: "failed",
      error: "guide format is outdated; retry",
    });
  });

  it("reads an unparsable or malformed file as failed", async () => {
    const g = guide();
    await store.write(keyOf(g), g);
    const [name] = readdirSync(guidesDir());
    const path = join(guidesDir(), name as string);
    writeFileSync(path, "{nope");
    expect(await store.read(keyOf(g))).toMatchObject({ state: "failed", error: /retry$/ });
    writeFileSync(path, JSON.stringify({ ...g, sections: [{ title: "t" }] }));
    expect(await store.read(keyOf(g))).toEqual({
      state: "failed",
      error: "the stored guide is malformed; retry",
    });
  });

  it("deletes a key's guide", async () => {
    const g = guide();
    await store.write(keyOf(g), g);
    await store.delete(keyOf(g));
    expect(await store.read(keyOf(g))).toBeUndefined();
    await store.delete(keyOf(g));
  });

  it("prunes every guide but the kept ones", async () => {
    await store.prune([]);
    const kept = guide();
    const dropped = guide("c".repeat(40));
    await store.write(keyOf(kept), kept);
    await store.write(keyOf(dropped), dropped);
    mkdirSync(join(guidesDir(), "sub"));
    await store.prune([keyOf(kept), "o/r#1@x..y"]);
    expect(await store.read(keyOf(kept))).toEqual({ state: "ready", guide: kept });
    expect(await store.read(keyOf(dropped))).toBeUndefined();
    expect(readdirSync(guidesDir()).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });
});
