import { describe, expect, it } from "vitest";
import { MAX_TEXT_FILE_BYTES, readTextFile } from "./text-file";

const file = (parts: BlobPart[], name = "a.txt", type = "") => new File(parts, name, { type });

// jest-dom's Vitest matchers break `rejects.toThrow(string)` (Vitest 5); match message instead.
const rejection = (parts: BlobPart[], name: string, message: string) =>
  expect(readTextFile(file(parts, name))).rejects.toMatchObject({ message });

describe("readTextFile", () => {
  it("decodes UTF-8 regardless of MIME type and strips a leading BOM", async () => {
    expect(await readTextFile(file(["héllo\n"], "a.ts", "video/mp2t"))).toBe("héllo\n");
    expect(await readTextFile(file([new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])]))).toBe("hi");
  });

  it("rejects binary content", async () => {
    await rejection([new Uint8Array([0x61, 0, 0x62])], "a.bin", "a.bin isn't a text file");
    await rejection([new Uint8Array([0xff, 0xfe, 0x41])], "b.dat", "b.dat isn't a text file");
  });

  it("rejects empty files", async () => {
    await rejection([], "e.txt", "e.txt is empty");
    await rejection([new Uint8Array([0xef, 0xbb, 0xbf])], "bom.txt", "bom.txt is empty");
  });

  it("accepts up to 512 KB", async () => {
    const max = "x".repeat(MAX_TEXT_FILE_BYTES);
    expect(await readTextFile(file([max]))).toHaveLength(MAX_TEXT_FILE_BYTES);
    await rejection([`${max}x`], "big.log", "big.log is too large (over 512 KB)");
  });
});
