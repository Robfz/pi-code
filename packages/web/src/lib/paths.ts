/** `path` relative to `cwd` when it is an absolute path inside it; otherwise `path` unchanged. */
export function cwdRelative(path: string, cwd: string): string {
  if (cwd === "" || !path.startsWith("/")) return path;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : path;
}
