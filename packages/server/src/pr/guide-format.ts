/** The PR guide format's version and shape checks (design/11-pr-guide.md, "Guide format"). */
import type { PrGuideSection } from "@pi-code/protocol";

/**
 * The guide format's version. A guide names hunks by their place in the pinned PR diff, so it
 * goes up whenever the guide's shape or the hunks' ids change (diff options, splitting).
 */
export const GUIDE_VERSION = 1;

const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

/**
 * A section's shape: a title, an explanation and hunk ids. What a section's hunks may be is the
 * guide job's to check (`buildGuide`).
 */
export function isGuideSection(value: unknown): value is PrGuideSection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isString(v.title) && isString(v.explanation) && isStringArray(v.hunks);
}

/** A guide's shape, its version aside. */
export function isGuide(value: Record<string, unknown>): boolean {
  return (
    isString(value.repo) &&
    Number.isSafeInteger(value.number) &&
    isString(value.baseSha) &&
    isString(value.headSha) &&
    Array.isArray(value.sections) &&
    value.sections.every(isGuideSection) &&
    isStringArray(value.other)
  );
}
