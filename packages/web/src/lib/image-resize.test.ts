import { describe, expect, it, vi } from "vitest";
import {
  browserCodec,
  fitWithin,
  type ImageCodec,
  JPEG_QUALITY,
  MAX_EDGE,
  prepareImage,
} from "./image-resize";

const MB = 1024 * 1024;

function file(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type });
}

function codec(width: number, height: number, jpegBytes = 200_000) {
  const close = vi.fn();
  const fake = {
    decode: vi.fn(async () => ({ width, height, source: {} as CanvasImageSource, close })),
    encodeJpeg: vi.fn(async () => new Blob([new Uint8Array(jpegBytes)], { type: "image/jpeg" })),
    toBase64: vi.fn(async (blob: Blob) => `b64:${blob.type}:${blob.size}`),
  } satisfies ImageCodec;
  return { fake, close };
}

describe("fitWithin", () => {
  it("scales the long side down to the limit, keeping the aspect ratio", () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: 2048 });
    expect(fitWithin(1000, 800)).toEqual({ width: 1000, height: 800 });
    expect(fitWithin(10_000, 1)).toEqual({ width: 2048, height: 1 });
  });
});

describe("prepareImage", () => {
  it("keeps small PNG / GIF files as they are", async () => {
    for (const type of ["image/png", "image/gif"]) {
      const { fake, close } = codec(800, 600);
      const image = await prepareImage(file("a", type, 300_000), fake);
      expect(image).toEqual({ type: "image", data: `b64:${type}:300000`, mimeType: type });
      expect(fake.encodeJpeg).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
    }
  });

  it("downscales large photos to 2048 px JPEG", async () => {
    const { fake } = codec(4032, 3024);
    const image = await prepareImage(file("photo.jpg", "image/jpeg", 800_000), fake);
    expect(fake.encodeJpeg).toHaveBeenCalledWith(expect.anything(), 2048, 1536, JPEG_QUALITY);
    expect(image).toEqual({ type: "image", data: "b64:image/jpeg:200000", mimeType: "image/jpeg" });
  });

  it("re-encodes heavy files even when their dimensions are small", async () => {
    const { fake } = codec(1200, 900);
    const image = await prepareImage(file("big.png", "image/png", 2 * MB), fake);
    expect(fake.encodeJpeg).toHaveBeenCalledWith(expect.anything(), 1200, 900, JPEG_QUALITY);
    expect(image.mimeType).toBe("image/jpeg");
  });

  it("re-encodes formats models don't take (HEIC)", async () => {
    const { fake } = codec(MAX_EDGE, 100);
    const image = await prepareImage(file("x.heic", "image/heic", 100_000), fake);
    expect(fake.encodeJpeg).toHaveBeenCalled();
    expect(image.mimeType).toBe("image/jpeg");
  });

  it("rejects non-images, undecodable files, and results still over 5 MB", async () => {
    // jest-dom's Vitest matchers break `rejects.toThrow(string)` (Vitest 5); match message instead.
    await expect(
      prepareImage(file("n.txt", "text/plain", 10), codec(1, 1).fake),
    ).rejects.toMatchObject({
      message: expect.stringContaining("isn't an image"),
    });
    const broken = codec(1, 1).fake;
    broken.decode.mockRejectedValueOnce(new Error("bad"));
    await expect(prepareImage(file("b.png", "image/png", 10), broken)).rejects.toMatchObject({
      message: "Couldn't read b.png",
    });
    const { fake, close } = codec(8000, 8000, 6 * MB);
    await expect(prepareImage(file("huge.png", "image/png", 40 * MB), fake)).rejects.toMatchObject({
      message: expect.stringContaining("too large"),
    });
    expect(close).toHaveBeenCalled();
  });
});

describe("browserCodec", () => {
  it("draws onto a white canvas at the target size and encodes JPEG", async () => {
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const ctx = { drawImage, fillRect, fillStyle: "" };
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      callback,
      type,
      quality,
    ) {
      expect([this.width, this.height, type, quality]).toEqual([300, 200, "image/jpeg", 0.85]);
      callback(new Blob(["jpeg"], { type: "image/jpeg" }));
    });
    const source = {} as CanvasImageSource;
    const blob = await browserCodec.encodeJpeg({ width: 600, height: 400, source }, 300, 200, 0.85);
    expect(blob.type).toBe("image/jpeg");
    expect(ctx.fillStyle).toBe("#fff");
    expect(fillRect).toHaveBeenCalledWith(0, 0, 300, 200);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 300, 200);
    getContext.mockRestore();
    toBlob.mockRestore();
  });

  it("reads blobs as base64", async () => {
    expect(await browserCodec.toBase64(new Blob([new Uint8Array([137, 80, 78, 71])]))).toBe(
      "iVBORw==",
    );
  });
});
