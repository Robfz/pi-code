import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, makeLayoutRepo } from "../testing/layout-repo.ts";
import { layoutOf } from "./layout.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-layout-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("layoutOf", () => {
  it("classifies the main checkout, the container and linked worktrees", () => {
    const { repo, main } = makeLayoutRepo(root, "pi-code");
    const sibling = join(repo, "feature");
    const outside = join(root, "elsewhere", "spike");
    git(main, "worktree", "add", "-q", "-b", "feature", sibling);
    git(main, "worktree", "add", "-q", "-b", "spike", outside);

    expect(layoutOf(main)).toEqual({ repo, role: "main", main });
    expect(layoutOf(repo)).toEqual({ repo, role: "container", main });
    expect(layoutOf(sibling)).toEqual({ repo, role: "worktree", main });
    expect(layoutOf(outside)).toEqual({ repo, role: "worktree", main });
  });

  it("accepts a master checkout", () => {
    const { repo, main } = makeLayoutRepo(root, "r", { branches: ["master"], checkout: "master" });
    const wt = join(repo, "wt");
    git(main, "worktree", "add", "-q", "-b", "wt", wt);
    expect(main).toBe(join(repo, "master"));
    expect(layoutOf(main)).toEqual({ repo, role: "main", main });
    expect(layoutOf(repo)).toEqual({ repo, role: "container", main });
    expect(layoutOf(wt)).toEqual({ repo, role: "worktree", main });
    expect(layoutOf(join(repo, "gone"))).toEqual({ repo, role: "worktree", main, missing: true });
  });

  it("gives none when both main and master are checkouts", () => {
    const { repo, main } = makeLayoutRepo(root, "r");
    const master = join(repo, "master");
    git(repo, "clone", "-q", join(root, "r.git"), master);
    expect(layoutOf(main)).toBeUndefined();
    expect(layoutOf(master)).toBeUndefined();
    expect(layoutOf(repo)).toBeUndefined();
    expect(layoutOf(join(repo, "gone"))).toBeUndefined();
  });

  it("gives none for a main checkout inside another work tree", () => {
    const outer = join(root, "outer");
    mkdirSync(outer);
    git(outer, "init", "-q");
    const { repo, main } = makeLayoutRepo(outer, "r");
    expect(layoutOf(main)).toBeUndefined();
    expect(layoutOf(repo)).toBeUndefined();
  });

  it("marks a missing folder under a layout container, not under a plain folder", () => {
    const { repo, main } = makeLayoutRepo(root, "r");
    expect(layoutOf(join(repo, "old-spike"))).toEqual({
      repo,
      role: "worktree",
      main,
      missing: true,
    });
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(layoutOf(join(plain, "gone"))).toBeUndefined();
  });

  it("gives none for submodules and bare common dirs", () => {
    const { repo, main } = makeLayoutRepo(root, "r");
    // A submodule's git dir has no `commondir`.
    const modules = join(main, ".git", "modules", "sub");
    mkdirSync(modules, { recursive: true });
    const submodule = join(repo, "sub");
    mkdirSync(submodule);
    writeFileSync(join(submodule, ".git"), `gitdir: ${modules}\n`);
    expect(layoutOf(submodule)).toBeUndefined();

    // A worktree of a bare repo kept inside `main`: its common dir isn't named `.git`.
    const admin = join(main, "bare.git", "worktrees", "wt");
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, "commondir"), "../..\n");
    const wt = join(repo, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${admin}\n`);
    expect(layoutOf(wt)).toBeUndefined();
  });

  it("resolves a relative gitdir and commondir", () => {
    const { repo, main } = makeLayoutRepo(root, "r");
    const admin = join(main, ".git", "worktrees", "rel");
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, "commondir"), "../..\n");
    const wt = join(repo, "rel");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), "gitdir: ../main/.git/worktrees/rel\n");
    expect(layoutOf(wt)).toEqual({ repo, role: "worktree", main });
  });

  it("gives none for plain clones, checkout subfolders and relative paths", () => {
    const { main } = makeLayoutRepo(root, "r");
    const sub = join(main, "packages");
    mkdirSync(sub);
    expect(layoutOf(sub)).toBeUndefined();
    const plain = join(root, "dotfiles");
    git(root, "clone", "-q", join(root, "r.git"), plain);
    expect(layoutOf(plain)).toBeUndefined();
    expect(layoutOf(root)).toBeUndefined();
    expect(layoutOf("r/main")).toBeUndefined();
  });
});
