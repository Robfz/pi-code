/**
 * Prompt text-file preparation: a picked file is read as UTF-8 and inlined into the message as a
 * `<file>` block (`formatFileBlock` in `@pi-code/protocol`). Binary files (a NUL byte or invalid
 * UTF-8), empty files and files over `MAX_TEXT_FILE_BYTES` are rejected.
 */

export const MAX_TEXT_FILE_BYTES = 512 * 1024;

export class TextFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextFileError";
  }
}

/** The file's text, without a leading BOM. */
export async function readTextFile(file: File): Promise<string> {
  if (file.size > MAX_TEXT_FILE_BYTES) {
    throw new TextFileError(`${file.name} is too large (over 512 KB)`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new TextFileError(`Couldn't read ${file.name}`);
  }
  if (bytes.includes(0)) throw new TextFileError(`${file.name} isn't a text file`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TextFileError(`${file.name} isn't a text file`);
  }
  if (text === "") throw new TextFileError(`${file.name} is empty`);
  return text;
}
