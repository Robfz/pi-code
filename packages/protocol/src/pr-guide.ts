/**
 * Ids of the PR guide's units (`docs/design/11-pr-guide.md`), shared so the server and the web
 * client name the PR diff's hunks alike: `<path>#<n>` for a file's n-th hunk (1-based, the new
 * path for renames), `<path>#0` for a file without hunks (binary, too large, or no content
 * change). The path is written with `oneLine`, so an id is always one line.
 */

/**
 * Third-party text kept on its line: control characters and line separators (a file name may hold
 * a newline) written as `\uXXXX`. Also the server's escaping of PR text in prompts, so a path
 * reads the same in a hunk id and around it.
 */
export function oneLine(text: string): string {
  return text.replace(
    /[\p{Cc}\p{Zl}\p{Zp}]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The id of the `index`-th hunk (1-based) of the file at `path`. */
export function guideHunkId(path: string, index: number): string {
  return `${oneLine(path)}#${index}`;
}

/** The id of the file at `path` as a whole, for a file without hunks. */
export function guideFileId(path: string): string {
  return guideHunkId(path, 0);
}
