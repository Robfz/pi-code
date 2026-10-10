/**
 * Line references in prompt and reply text: `@path:N`, `@path:N-M`, `@"dir name/a.ts":N` and,
 * naming a committed version, `@<sha>:./path:N-M` (git's `<rev>:./<path>`). pi passes them to
 * the model verbatim; pi-code colors them and opens them. Syntax: `docs/design/07-code-review.md`.
 */

export interface CodeRef {
  /** Cwd-relative or absolute. */
  path: string;
  /** 1-based, inclusive; `start === end` for one line. */
  start: number;
  end: number;
  /** Short or full commit sha. */
  rev?: string;
}

/** A reference found in a text, at UTF-16 offsets `index` to `index + length`. */
export interface CodeRefMatch extends CodeRef {
  index: number;
  length: number;
}

const REV = /([0-9a-f]{7,40}):/y;
const LINES = /:([1-9]\d*)(?:-([1-9]\d*))?/y;
const WHITESPACE = /\s/;
const END_CHARS = new Set("`.,;:!?)]}'\"");

const isWhitespace = (char: string) => WHITESPACE.test(char);

/** Whether a reference may start at `at`: the text start, or after whitespace or a backtick. */
function canStart(text: string, at: number): boolean {
  const before = text[at - 1];
  return before === undefined || before === "`" || isWhitespace(before);
}

/** Whether a reference may end at `at`: the text end, whitespace or a closing punctuation mark. */
function canEnd(text: string, at: number): boolean {
  const after = text[at];
  return after === undefined || END_CHARS.has(after) || isWhitespace(after);
}

interface Parsed {
  path: string;
  start: number;
  end: number;
  /** Offset just past the reference. */
  to: number;
}

/** `:N` or `:N-M` at `at`, followed by the end of a reference. */
function parseLines(text: string, at: number): Omit<Parsed, "path"> | null {
  LINES.lastIndex = at;
  const match = LINES.exec(text);
  if (!match || !canEnd(text, LINES.lastIndex)) return null;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (match[2] !== undefined && end <= start) return null;
  return { start, end, to: LINES.lastIndex };
}

/** A quoted or bare path at `at`, then its line spec. */
function parsePathAndLines(text: string, at: number): Parsed | null {
  if (text[at] === '"') {
    const close = text.indexOf('"', at + 1);
    const path = close === -1 ? "" : text.slice(at + 1, close);
    if (!path || /[\r\n]/.test(path)) return null;
    const lines = parseLines(text, close + 1);
    return lines && { path, ...lines };
  }
  // A bare path may contain `:`; the first `:N` / `:N-M` that ends a reference is the line spec.
  for (let i = at; i < text.length; i++) {
    const char = text[i] as string;
    if (char === '"' || char === "`" || isWhitespace(char)) return null;
    if (char !== ":" || i === at) continue;
    const lines = parseLines(text, i);
    if (lines) return { path: text.slice(at, i), ...lines };
  }
  return null;
}

/** A path as read after a rev: git's `./` ("from the current directory") isn't part of it. */
const pathAfterRev = (path: string) =>
  path.startsWith("./") && path.length > 2 ? path.slice(2) : path;

/** The reference whose `@` is at `at`, if any. */
function parseAt(text: string, at: number): CodeRefMatch | null {
  REV.lastIndex = at + 1;
  const rev = REV.exec(text);
  if (rev) {
    const parsed = parsePathAndLines(text, REV.lastIndex);
    if (parsed) {
      const { start, end, to } = parsed;
      return {
        path: pathAfterRev(parsed.path),
        start,
        end,
        rev: rev[1] as string,
        index: at,
        length: to - at,
      };
    }
  }
  const parsed = parsePathAndLines(text, at + 1);
  return (
    parsed && {
      path: parsed.path,
      start: parsed.start,
      end: parsed.end,
      index: at,
      length: parsed.to - at,
    }
  );
}

/** Every reference in `text`, in order, non-overlapping. */
export function findCodeRefs(text: string): CodeRefMatch[] {
  const refs: CodeRefMatch[] = [];
  for (let at = text.indexOf("@"); at !== -1; ) {
    const ref = canStart(text, at) ? parseAt(text, at) : null;
    if (ref) refs.push(ref);
    at = text.indexOf("@", ref ? at + ref.length : at + 1);
  }
  return refs;
}

/**
 * `@path:N` / `@path:N-M` / `@rev:./path:…`; null when the path can't be written (contains `"`
 * or a line break, or is empty). The path is quoted when its bare form wouldn't read back as
 * the same path: whitespace, a backtick, a leading `<rev>:` or an inner `:N` segment.
 */
export function formatCodeRef(ref: CodeRef): string | null {
  if (!ref.path || /["\r\n]/.test(ref.path)) return null;
  // git resolves `<rev>:./<path>` from the current directory and `<rev>:<path>` from the repo root.
  const path =
    ref.rev === undefined || ref.path.startsWith("./") || ref.path.startsWith("../")
      ? ref.path
      : `./${ref.path}`;
  const prefix = ref.rev === undefined ? "@" : `@${ref.rev}:`;
  const lines = ref.start === ref.end ? `:${ref.start}` : `:${ref.start}-${ref.end}`;
  const bare = `${prefix}${path}${lines}`;
  const [read] = findCodeRefs(bare);
  const expected = ref.rev === undefined ? ref.path : pathAfterRev(ref.path);
  const readsBack = read?.length === bare.length && read.path === expected && read.rev === ref.rev;
  return readsBack ? bare : `${prefix}"${path}"${lines}`;
}
