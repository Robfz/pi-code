import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasTrustRequiringProjectResources,
  needsTrustDecision,
  savedTrustDecision,
  TRUST_REQUIRING_PROJECT_RESOURCES,
} from "./trust.ts";

let root: string;
let home: string;
let project: string;
let agentDir: string;
let trustFile: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-trust-")));
  home = join(root, "home");
  project = join(home, "code", "project");
  agentDir = join(home, ".pi", "agent");
  trustFile = join(agentDir, "trust.json");
  mkdirSync(project, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeTrust(data: unknown): void {
  writeFileSync(trustFile, typeof data === "string" ? data : JSON.stringify(data));
}

describe("hasTrustRequiringProjectResources", () => {
  it("is false for an empty project and a bare .pi dir", async () => {
    expect(await hasTrustRequiringProjectResources(project, home)).toBe(false);
    mkdirSync(join(project, ".pi"));
    writeFileSync(join(project, ".pi", "other.json"), "{}");
    expect(await hasTrustRequiringProjectResources(project, home)).toBe(false);
  });

  it.each(TRUST_REQUIRING_PROJECT_RESOURCES)("detects .pi/%s", async (entry) => {
    mkdirSync(join(project, ".pi"));
    const path = join(project, ".pi", entry);
    if (entry.includes(".")) writeFileSync(path, "x");
    else mkdirSync(path);
    expect(await hasTrustRequiringProjectResources(project, home)).toBe(true);
  });

  it("ignores .pi resources of ancestors", async () => {
    mkdirSync(join(home, "code", ".pi"));
    writeFileSync(join(home, "code", ".pi", "settings.json"), "{}");
    expect(await hasTrustRequiringProjectResources(project, home)).toBe(false);
  });

  it("detects .agents/skills in the cwd or an ancestor, but not ~/.agents/skills", async () => {
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    expect(await hasTrustRequiringProjectResources(project, home)).toBe(false);
    mkdirSync(join(home, "code", ".agents", "skills"), { recursive: true });
    expect(await hasTrustRequiringProjectResources(project, home)).toBe(true);
    rmSync(join(home, "code", ".agents"), { recursive: true });
    mkdirSync(join(project, ".agents", "skills"), { recursive: true });
    expect(await hasTrustRequiringProjectResources(project, home)).toBe(true);
  });

  it("resolves symlinked cwds", async () => {
    mkdirSync(join(project, ".pi", "skills"), { recursive: true });
    const link = join(home, "link");
    symlinkSync(project, link);
    expect(await hasTrustRequiringProjectResources(link, home)).toBe(true);
  });
});

describe("savedTrustDecision", () => {
  it("finds an exact decision, true or false", async () => {
    writeTrust({ [project]: true });
    expect(await savedTrustDecision(trustFile, project)).toBe(true);
    writeTrust({ [project]: false });
    expect(await savedTrustDecision(trustFile, project)).toBe(false);
  });

  it("uses the closest parent decision; null entries don't count", async () => {
    writeTrust({ [home]: true, [join(home, "code")]: false });
    expect(await savedTrustDecision(trustFile, project)).toBe(false);
    writeTrust({ [home]: true, [join(home, "code")]: null, [project]: null });
    expect(await savedTrustDecision(trustFile, project)).toBe(true);
    writeTrust({ [join(project, "sub")]: true, "/elsewhere": false });
    expect(await savedTrustDecision(trustFile, project)).toBeNull();
  });

  it("matches the realpath of the cwd", async () => {
    const link = join(home, "link");
    symlinkSync(project, link);
    writeTrust({ [project]: true });
    expect(await savedTrustDecision(trustFile, link)).toBe(true);
    writeTrust({ [link]: true });
    expect(await savedTrustDecision(trustFile, link)).toBeNull();
  });

  it("treats a missing or garbage file as no decision", async () => {
    expect(await savedTrustDecision(trustFile, project)).toBeNull();
    for (const garbage of [
      "{not json",
      "[]",
      "null",
      '"x"',
      JSON.stringify({ [project]: "yes" }),
    ]) {
      writeTrust(garbage);
      expect(await savedTrustDecision(trustFile, project), garbage).toBeNull();
    }
    writeTrust(`\uFEFF${JSON.stringify({ [project]: false })}`);
    expect(await savedTrustDecision(trustFile, project)).toBe(false);
  });
});

describe("needsTrustDecision", () => {
  it("asks only when there are protected resources and no saved decision", async () => {
    const needs = () => needsTrustDecision({ cwd: project, home, agentDir });
    expect(await needs()).toBe(false);
    mkdirSync(join(project, ".pi"));
    writeFileSync(join(project, ".pi", "SYSTEM.md"), "x");
    expect(await needs()).toBe(true);
    writeTrust({ [home]: false });
    expect(await needs()).toBe(false);
    writeTrust("garbage");
    expect(await needs()).toBe(true);
  });
});
