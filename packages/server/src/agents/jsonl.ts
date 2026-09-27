/**
 * LF-only line splitter over a UTF-8 byte stream.
 *
 * Never use `readline` for pi's stdout: it also splits on U+2028/U+2029, which are valid inside
 * JSON strings. Lines are split on `\n` only; a trailing `\r` is stripped. The streaming decoder
 * keeps multi-byte code points intact across chunk boundaries.
 */
export class LineSplitter {
  private readonly decoder = new TextDecoder("utf-8");
  private pending: string[] = [];
  private readonly onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  push(chunk: Uint8Array): void {
    this.feed(this.decoder.decode(chunk, { stream: true }));
  }

  /** Flushes the decoder and emits a final unterminated line, if any. */
  end(): void {
    this.feed(this.decoder.decode());
    if (this.pending.length > 0) {
      const last = this.pending.join("");
      this.pending = [];
      if (last.length > 0) this.emit(last);
    }
  }

  private feed(text: string): void {
    if (text.length === 0) return;
    let start = 0;
    let nl = text.indexOf("\n", start);
    while (nl >= 0) {
      const piece = text.slice(start, nl);
      if (this.pending.length > 0) {
        this.pending.push(piece);
        const line = this.pending.join("");
        this.pending = [];
        this.emit(line);
      } else {
        this.emit(piece);
      }
      start = nl + 1;
      nl = text.indexOf("\n", start);
    }
    if (start < text.length) this.pending.push(text.slice(start));
  }

  private emit(line: string): void {
    this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}
