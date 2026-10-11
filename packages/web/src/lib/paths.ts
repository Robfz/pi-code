/** `path` relative to `cwd` when it is an absolute path inside it; otherwise `path` unchanged. */
export function cwdRelative(path: string, cwd: string): string {
  if (cwd === "" || !path.startsWith("/")) return path;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : path;
}

/** Basename and directory of a path ("src/app.ts" → "app.ts", "src"). */
export function splitPath(path: string): { base: string; dir: string } {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) return { base: trimmed, dir: "" };
  if (slash === 0) return { base: trimmed.slice(1) || "/", dir: trimmed.length > 1 ? "/" : "" };
  return { base: trimmed.slice(slash + 1), dir: trimmed.slice(0, slash) };
}
