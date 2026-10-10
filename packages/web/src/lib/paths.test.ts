import { describe, expect, it } from "vitest";
import { cwdRelative } from "./paths";

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
