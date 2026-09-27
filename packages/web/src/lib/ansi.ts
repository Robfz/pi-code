const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// CSI sequences (colors, cursor moves), OSC sequences (hyperlinks, titles), and lone two-char escapes.
const ANSI_PATTERN = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}[@-Z\\\\-_]`,
  ].join("|"),
  "g",
);

/** Remove ANSI escape sequences (extension status texts and widgets may contain them). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
