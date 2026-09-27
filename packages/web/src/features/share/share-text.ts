export interface SharedContent {
  title?: string;
  text?: string;
  url?: string;
}

/** `title`, `text`, `url` from a share-target query string (raw, not JSON-parsed). */
export function parseShareParams(search: string): SharedContent {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: SharedContent = {};
  for (const key of ["title", "text", "url"] as const) {
    const value = params.get(key);
    if (value !== null && value.trim() !== "") out[key] = value.trim();
  }
  return out;
}

function includes(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Composer text from shared content: title, text and URL as paragraphs, skipping repeats —
 * apps often put the URL inside `text`, or repeat the title there.
 */
export function composeShareText({ title = "", text = "", url = "" }: SharedContent): string {
  const t = title.trim();
  const u = url.trim();
  let body = text.trim();
  if (body !== "" && t !== "" && body !== t && includes(t, body)) body = "";
  const showTitle = t !== "" && t !== u && !includes(body, t);
  const showUrl = u !== "" && !body.includes(u) && !(showTitle && t.includes(u));
  return [showTitle ? t : "", body, showUrl ? u : ""].filter((p) => p !== "").join("\n\n");
}
