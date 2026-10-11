import { describe, expect, it } from "vitest";
import { cwdRelative, splitPath } from "./paths";

describe("cwdRelative", () => {
  it.each([
    ["/home/me/project/src/a.ts", "/home/me/project", "src/a.ts"],
    ["/home/me/project/src/a.ts", "/home/me/project/", "src/a.ts"],
    ["/home/me/projectx/a.ts", "/home/me/project", "/home/me/projectx/a.ts"],
    ["/etc/hosts", "/home/me/project", "/etc/hosts"],
    ["/home/me/project", "/home/me/project", "/home/me/project"],
    ["src/a.ts", "/home/me/project", "src/a.ts"],
    ["../x.ts", "/home/me/project", "../x.ts"],
    ["/a.ts", "", "/a.ts"],
  ])("%s in %s → %s", (path, cwd, expected) => {
    expect(cwdRelative(path, cwd)).toBe(expected);
  });
});

describe("splitPath", () => {
  it("splits basename and directory", () => {
    expect(splitPath("src/a/b.ts")).toEqual({ base: "b.ts", dir: "src/a" });
    expect(splitPath("b.ts")).toEqual({ base: "b.ts", dir: "" });
    expect(splitPath("/b.ts")).toEqual({ base: "b.ts", dir: "/" });
    expect(splitPath("src/")).toEqual({ base: "src", dir: "" });
    expect(splitPath("/")).toEqual({ base: "/", dir: "" });
    expect(splitPath(".")).toEqual({ base: ".", dir: "" });
  });
});
