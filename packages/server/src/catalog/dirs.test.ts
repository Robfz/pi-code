import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isApiError } from "../errors.ts";
import { listDirs, MAX_DIR_SUGGESTIONS, splitPrefix } from "./dirs.ts";

let root: string;
let home: string;
let sessionCwds: Set<string>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-dirs-")));
  home = join(root, "home");
  for (const d of [
    "Dev/pi-code/.git",
    "Dev/other",
    "Desktop",
    "Documents",
    ".config/pi",
    ".cache",
  ]) {
    mkdirSync(join(home, d), { recursive: true });
  }
  writeFileSync(join(home, "Dev.txt"), "a file");
  mkdirSync(join(root, "outside", "secret"), { recursive: true });
  sessionCwds = new Set([join(home, "Dev", "pi-code")]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const list = (prefix: string) => listDirs(prefix, { home, sessionCwds: async () => sessionCwds });
const paths = async (prefix: string) => (await list(prefix)).map((d) => d.path);

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("splitPrefix", () => {
  it("splits into the directory to list and the partial name", () => {
    expect(splitPrefix("~/De", "/h")).toEqual({ dir: "/h", partial: "De" });
    expect(splitPrefix("~/Dev/", "/h")).toEqual({ dir: "/h/Dev", partial: "" });
    expect(splitPrefix("~", "/h")).toEqual({ dir: "/h", partial: "" });
    expect(splitPrefix("", "/h")).toEqual({ dir: "/h", partial: "" });
    expect(splitPrefix("/h/Dev/pi", "/h")).toEqual({ dir: "/h/Dev", partial: "pi" });
    expect(splitPrefix("~/a/../b/x", "/h")).toEqual({ dir: "/h/b", partial: "x" });
  });
});

describe("listDirs", () => {
  it("expands ~ and lists matching directories only", async () => {
    expect(await paths("~/De")).toEqual([join(home, "Desktop"), join(home, "Dev")]);
    expect(await paths("~/de")).toEqual([join(home, "Desktop"), join(home, "Dev")]);
    expect(await paths("~/Dev/")).toEqual([
      join(home, "Dev", "other"),
      join(home, "Dev", "pi-code"),
    ]);
    expect(await paths("~")).toEqual([
      join(home, "Desktop"),
      join(home, "Dev"),
      join(home, "Documents"),
    ]);
    expect(await paths(`${home}/Do`)).toEqual([join(home, "Documents")]);
  });

  it("shows dot-directories only when the typed segment starts with a dot", async () => {
    expect(await paths("~/")).not.toContain(join(home, ".config"));
    expect(await paths("~/.")).toEqual([join(home, ".cache"), join(home, ".config")]);
    expect(await paths("~/.co")).toEqual([join(home, ".config")]);
    expect(await paths("~/Dev/pi-code/")).toEqual([]);
    expect(await paths("~/Dev/pi-code/.")).toEqual([join(home, "Dev", "pi-code", ".git")]);
  });

  it("flags git repos and directories with sessions", async () => {
    expect(await list("~/Dev/")).toEqual([
      { path: join(home, "Dev", "other"), isGitRepo: false, hasSessions: false },
      { path: join(home, "Dev", "pi-code"), isGitRepo: true, hasSessions: true },
    ]);
  });

  it("rejects prefixes outside $HOME, including symlink escapes", async () => {
    symlinkSync(join(root, "outside"), join(home, "escape"));
    for (const prefix of ["/", `${root}/`, "~/../", "~/../outside/", "~/escape/", "~/escape/se"]) {
      const err = await rejection(list(prefix));
      expect(isApiError(err, "outside_home"), prefix).toBe(true);
    }
    const bad = await rejection(list("relative/path"));
    expect(isApiError(bad, "invalid_body")).toBe(true);
  });

  it("drops symlinked children that resolve outside $HOME, keeps those inside", async () => {
    symlinkSync(join(root, "outside"), join(home, "Escape"));
    symlinkSync(join(home, "Dev"), join(home, "DevLink"));
    symlinkSync(join(home, "Dev.txt"), join(home, "DevFile"));
    expect(await paths("~/")).toEqual([
      join(home, "Desktop"),
      join(home, "Dev"),
      join(home, "DevLink"),
      join(home, "Documents"),
    ]);
  });

  it("returns nothing for a missing directory, and at most 50 entries", async () => {
    expect(await list("~/missing/x")).toEqual([]);
    const many = join(home, "many");
    for (let i = 0; i < 70; i++)
      mkdirSync(join(many, `d${String(i).padStart(2, "0")}`), { recursive: true });
    const dirs = await paths("~/many/");
    expect(dirs).toHaveLength(MAX_DIR_SUGGESTIONS);
    expect(dirs[0]).toBe(join(many, "d00"));
  });
});
