import type { RepoLayout } from "@pi-code/protocol";
import { describe, expect, it } from "vitest";
import { groupListing, type ListingGroup } from "./listing-groups";

interface Item {
  id: string;
  cwd: string;
  /** The last prompt's time; with `unprompted`, the creation's. */
  at: number;
  unprompted?: true;
  layout?: RepoLayout;
  missing?: true;
}

const group = (items: Item[], repos?: string[]) =>
  groupListing(
    items,
    {
      cwd: (item) => item.cwd,
      layout: (item) => item.layout,
      recency: (item) => ({ prompted: item.unprompted !== true, at: item.at }),
      missing: (item) => item.missing === true,
    },
    repos ? { repos } : {},
  );

const ids = (items: Item[]) => items.map((item) => item.id);

function repoGroup(groups: ListingGroup<Item>[], repo: string) {
  const found = groups.find((g) => g.kind === "repo" && g.repo === repo);
  if (found?.kind !== "repo") throw new Error(`no repo group ${repo}`);
  return found;
}

const R = "/home/me/Dev/pi-code";
const main: RepoLayout = { repo: R, role: "main" };
const linked: RepoLayout = { repo: R, role: "worktree" };
const container: RepoLayout = { repo: R, role: "container" };

describe("groupListing", () => {
  it("nests checkouts in their repo group: main first, then by most recent item", () => {
    const groups = group([
      { id: "m1", cwd: `${R}/main`, at: 1, layout: main },
      { id: "w1", cwd: `${R}/wt-old`, at: 3, layout: linked },
      { id: "w2", cwd: `${R}/wt-new`, at: 5, layout: linked },
      { id: "w3", cwd: `${R}/wt-old`, at: 6, layout: linked },
      { id: "m2", cwd: `${R}/main`, at: 2, layout: main },
    ]);
    expect(groups).toHaveLength(1);
    const repo = repoGroup(groups, R);
    expect(repo.label).toBe("pi-code");
    expect(repo.items).toEqual([]);
    expect(repo.worktrees.map((w) => [w.label, w.role, ids(w.items)])).toEqual([
      ["main", "main", ["m2", "m1"]],
      ["wt-old", "worktree", ["w3", "w1"]],
      ["wt-new", "worktree", ["w2"]],
    ]);
  });

  it("puts container items under the repo header, also when they're all it has", () => {
    const other = "/home/me/Dev/notes";
    const groups = group([
      { id: "c1", cwd: R, at: 4, layout: container },
      { id: "m1", cwd: `${R}/main`, at: 5, layout: main },
      { id: "c2", cwd: R, at: 6, layout: container },
      { id: "n1", cwd: other, at: 1, layout: { repo: other, role: "container" } },
    ]);
    const repo = repoGroup(groups, R);
    expect(ids(repo.items)).toEqual(["c2", "c1"]);
    expect(repo.worktrees.map((w) => w.cwd)).toEqual([`${R}/main`]);
    const notes = repoGroup(groups, other);
    expect(ids(notes.items)).toEqual(["n1"]);
    expect(notes.worktrees).toEqual([]);
  });

  it("orders repo and folder groups by their most recent item", () => {
    const groups = group([
      { id: "f1", cwd: "/home/me/alpha", at: 2 },
      { id: "m1", cwd: `${R}/main`, at: 1, layout: main },
      { id: "w1", cwd: `${R}/wt`, at: 9, layout: linked },
      { id: "f2", cwd: "/home/me/beta", at: 5 },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["pi-code", "beta", "alpha"]);
  });

  it("applies the collision rule across repo and folder groups", () => {
    const groups = group([
      { id: "m1", cwd: `${R}/main`, at: 3, layout: main },
      { id: "f1", cwd: "/home/me/forks/pi-code", at: 2 },
      { id: "f2", cwd: "/home/me/other", at: 1 },
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Dev/pi-code", "forks/pi-code", "other"]);
  });

  it("puts unprompted items after prompted ones, newest created first, and groups likewise", () => {
    const groups = group([
      { id: "new-empty", cwd: "/home/me/alpha", at: 9, unprompted: true },
      { id: "old-prompt", cwd: "/home/me/alpha", at: 1 },
      { id: "empty-only", cwd: "/home/me/beta", at: 10, unprompted: true },
      { id: "older-empty", cwd: "/home/me/alpha", at: 5, unprompted: true },
      { id: "fresh-wt", cwd: `${R}/fresh`, at: 8, unprompted: true, layout: linked },
      { id: "m1", cwd: `${R}/main`, at: 3, unprompted: true, layout: main },
      { id: "empty-gamma", cwd: "/home/me/gamma", at: 2, unprompted: true },
    ]);
    expect(groups.map((g) => [g.label, ids(g.items)])).toEqual([
      ["alpha", ["old-prompt", "new-empty", "older-empty"]],
      ["beta", ["empty-only"]],
      ["pi-code", []],
      ["gamma", ["empty-gamma"]],
    ]);
    expect(repoGroup(groups, R).worktrees.map((w) => w.label)).toEqual(["main", "fresh"]);
  });

  it("adds empty repo groups for `repos` without items, labelled with the rest", () => {
    const groups = group([{ id: "f1", cwd: "/home/me/forks/pi-code", at: 2 }], [R, "/x/empty"]);
    expect(groups.map((g) => [g.kind, g.label, g.items.length])).toEqual([
      ["folder", "forks/pi-code", 1],
      ["repo", "Dev/pi-code", 0],
      ["repo", "empty", 0],
    ]);
    // A repo that has items keeps its place.
    const withItems = group([{ id: "m1", cwd: `${R}/main`, at: 1, layout: main }], [R]);
    expect(withItems).toHaveLength(1);
    expect(repoGroup(withItems, R).worktrees).toHaveLength(1);
  });

  it("marks a worktree missing when any of its items says so", () => {
    const groups = group([
      { id: "w1", cwd: `${R}/spike`, at: 2, layout: linked },
      { id: "w2", cwd: `${R}/spike`, at: 1, layout: { ...linked, missing: true } },
      { id: "w3", cwd: `${R}/fine`, at: 3, layout: linked },
    ]);
    const repo = repoGroup(groups, R);
    expect(repo.worktrees.map((w) => [w.label, w.missing])).toEqual([
      ["fine", false],
      ["spike", true],
    ]);
  });

  it("marks a folder missing when any of its items says so", () => {
    const groups = group([
      { id: "1", cwd: "/home/me/gone", at: 2 },
      { id: "2", cwd: "/home/me/gone", at: 1, missing: true },
      { id: "3", cwd: "/home/me/here", at: 3 },
    ]);
    expect(groups.map((g) => g.kind === "folder" && [g.label, g.missing])).toEqual([
      ["here", false],
      ["gone", true],
    ]);
  });

  it("groups items without layout by cwd, as the flat folder groups", () => {
    const groups = group([
      { id: "1", cwd: "/home/me/Kepi/phoenix", at: 3 },
      { id: "2", cwd: "/home/me/phoenix/phoenix", at: 4 },
      { id: "3", cwd: "/home/me/pi-code/", at: 1 },
      { id: "4", cwd: "/home/me/Kepi/phoenix", at: 5 },
    ]);
    expect(groups).toEqual([
      {
        kind: "folder",
        cwd: "/home/me/Kepi/phoenix",
        label: "Kepi/phoenix",
        missing: false,
        items: [
          { id: "4", cwd: "/home/me/Kepi/phoenix", at: 5 },
          { id: "1", cwd: "/home/me/Kepi/phoenix", at: 3 },
        ],
      },
      {
        kind: "folder",
        cwd: "/home/me/phoenix/phoenix",
        label: "phoenix/phoenix",
        missing: false,
        items: [{ id: "2", cwd: "/home/me/phoenix/phoenix", at: 4 }],
      },
      {
        kind: "folder",
        cwd: "/home/me/pi-code/",
        label: "pi-code",
        missing: false,
        items: [{ id: "3", cwd: "/home/me/pi-code/", at: 1 }],
      },
    ]);
  });
});
