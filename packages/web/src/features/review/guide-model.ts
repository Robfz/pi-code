/**
 * The Guide tab's model (`docs/design/11-pr-guide.md`, "Web client"): a ready guide's sections and
 * "Other changes" as items of file cards, and the item the scroll position is in.
 */

import type { PrGuideNoHunks, PrGuideResponse, PrGuideUnit } from "@pi-code/protocol";
import { EXPAND_MAX_FILES, EXPAND_MAX_LINES } from "./file-card";

export type ReadyGuide = Extract<PrGuideResponse, { state: "ready" }>;

/** One file of an item: its hunks of that item as one patch, or the file without hunks. */
export interface GuideCard {
  /** Unique within its item. */
  key: string;
  path: string;
  oldPath?: string;
  status: PrGuideUnit["status"];
  /** The file's totals. */
  additions: number;
  deletions: number;
  /** The file's header lines then the card's hunks in file order. */
  patch?: string;
  noHunks?: PrGuideNoHunks;
  /**
   * Unchanged lines can be expanded: the card holds every hunk of its file, so the library's
   * expansion, which spans the whole file, never shows another hunk's lines as unchanged; and the
   * file is on both sides (not added or deleted, nor either half of a type change, which git
   * reports as modified).
   */
  expandable: boolean;
}

export interface GuideItem {
  title: string;
  /** Markdown; absent for "Other changes". */
  explanation?: string;
  cards: GuideCard[];
}

/** A hunk's file header lines (`diff --git` … `+++`), which group hunks into one card. */
function patchHeader(patch: string): string {
  const start = patch.search(/^@@ /m);
  return start === -1 ? patch : patch.slice(0, start);
}

/** File header lines with a side missing: an added or deleted file, or half of a type change. */
const ONE_SIDED = /^(?:--- \/dev\/null|\+\+\+ \/dev\/null|new file mode |deleted file mode )/m;

/** The `n` of a hunk id `<path>#<n>`. */
function hunkIndex(id: string): number {
  return Number(id.slice(id.lastIndexOf("#") + 1));
}

/**
 * The cards of `ids`: hunks grouped by file (a type change's two `diff --git` sections are two
 * files) in the order the files first appear, each file's hunks in file order. `fileHunks` counts
 * every hunk per file header.
 */
function cardsOf(
  ids: readonly string[],
  units: ReadyGuide["units"],
  fileHunks: ReadonlyMap<string, number>,
): GuideCard[] {
  const groups = new Map<string, { unit: PrGuideUnit; ids: string[] }>();
  for (const id of ids) {
    const unit = units[id];
    if (unit === undefined) continue;
    const key = "patch" in unit ? patchHeader(unit.patch) : id;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { unit, ids: [id] });
    else if (!group.ids.includes(id)) group.ids.push(id);
  }
  return [...groups].map(([key, { unit, ids }]) => {
    const card: GuideCard = {
      key,
      path: unit.path,
      status: unit.status,
      additions: unit.additions,
      deletions: unit.deletions,
      expandable: false,
    };
    if (unit.oldPath !== undefined) card.oldPath = unit.oldPath;
    if ("noHunks" in unit) {
      card.noHunks = unit.noHunks;
      return card;
    }
    const hunks = ids
      .sort((a, b) => hunkIndex(a) - hunkIndex(b))
      .map((id) => {
        const hunk = units[id] as { patch: string };
        return hunk.patch.slice(patchHeader(hunk.patch).length);
      });
    card.patch = key + hunks.join("");
    card.expandable = ids.length === fileHunks.get(key) && !ONE_SIDED.test(key);
    return card;
  });
}

/** The guide's sections, then "Other changes" when it lists anything. */
export function guideItems({ guide, units }: Pick<ReadyGuide, "guide" | "units">): GuideItem[] {
  // `units` holds every unit of the PR diff: the sections' and the others.
  const fileHunks = new Map<string, number>();
  for (const unit of Object.values(units)) {
    if (!("patch" in unit)) continue;
    const header = patchHeader(unit.patch);
    fileHunks.set(header, (fileHunks.get(header) ?? 0) + 1);
  }
  const items: GuideItem[] = guide.sections.map((section) => ({
    title: section.title,
    explanation: section.explanation,
    cards: cardsOf(section.hunks, units, fileHunks),
  }));
  if (guide.other.length > 0) {
    items.push({ title: "Other changes", cards: cardsOf(guide.other, units, fileHunks) });
  }
  return items;
}

/**
 * Whether file cards start expanded: not past the Changes tab's limits, counted over the PR's
 * files (the units' paths) and their added plus deleted lines.
 */
export function expandCards(units: ReadyGuide["units"]): boolean {
  const files = new Map<string, number>();
  for (const unit of Object.values(units)) files.set(unit.path, unit.additions + unit.deletions);
  let lines = 0;
  for (const count of files.values()) lines += count;
  return files.size <= EXPAND_MAX_FILES && lines <= EXPAND_MAX_LINES;
}

/**
 * The item the reader is in: the last one whose top (relative to the scroll area) has reached
 * `offset` (the sticky bar's bottom), else the first; the last one once scrolled to the end, where
 * the last items may be too short to reach the bar.
 */
export function currentItem(tops: readonly number[], offset: number, atEnd: boolean): number {
  if (atEnd) return Math.max(tops.length - 1, 0);
  let current = 0;
  tops.forEach((top, index) => {
    if (top <= offset) current = index;
  });
  return current;
}
