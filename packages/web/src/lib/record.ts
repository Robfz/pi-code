/** Defensive field access on untyped values (tool args, results, extension details). */

export type Rec = Record<string, unknown>;

export function asRecord(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

export function str(value: unknown, key: string): string | undefined {
  const v = asRecord(value)?.[key];
  return typeof v === "string" ? v : undefined;
}

export function num(value: unknown, key: string): number | undefined {
  const v = asRecord(value)?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Tool arguments' file path (`path`, or `file_path` as some models send). */
export function argPath(args: unknown): string | undefined {
  return str(args, "path") ?? str(args, "file_path");
}
