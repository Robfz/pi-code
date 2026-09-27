/**
 * Prompt image preparation: phone photos are often 12+ MP and several MB, far more than a model
 * needs and more than a prompt should carry. Images larger than `MAX_EDGE` on their long side,
 * heavier than `KEEP_MAX_BYTES`, or in a format models don't take are redrawn on a canvas at
 * most `MAX_EDGE` px and encoded as JPEG; small PNG / JPEG / GIF / WebP files go as they are.
 */

import type { ImageContent } from "@pi-code/protocol";

export const MAX_EDGE = 2048;
export const KEEP_MAX_BYTES = 1.5 * 1024 * 1024;
export const MAX_BYTES = 5 * 1024 * 1024;
export const JPEG_QUALITY = 0.85;

/** Formats sent unchanged when small enough. */
const PASSTHROUGH_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export class ImagePrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImagePrepareError";
  }
}

export interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
  close?(): void;
}

/** Browser primitives, injectable for tests (jsdom has no image decoding or canvas). */
export interface ImageCodec {
  decode(file: Blob): Promise<DecodedImage>;
  /** Draw `image` at `width`×`height` and encode it as JPEG. */
  encodeJpeg(image: DecodedImage, width: number, height: number, quality: number): Promise<Blob>;
  toBase64(blob: Blob): Promise<string>;
}

/** Size that fits `max` on the long side, keeping the aspect ratio (never upscales). */
export function fitWithin(
  width: number,
  height: number,
  max = MAX_EDGE,
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const scale = max / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Turn a picked file into prompt `ImageContent`, downscaling / re-encoding as needed. */
export async function prepareImage(
  file: File,
  codec: ImageCodec = browserCodec,
): Promise<ImageContent> {
  const type = file.type.toLowerCase();
  if (!type.startsWith("image/")) throw new ImagePrepareError(`${file.name} isn't an image`);
  let image: DecodedImage;
  try {
    image = await codec.decode(file);
  } catch {
    throw new ImagePrepareError(`Couldn't read ${file.name}`);
  }
  try {
    const small = Math.max(image.width, image.height) <= MAX_EDGE && file.size <= KEEP_MAX_BYTES;
    if (small && PASSTHROUGH_TYPES.has(type)) {
      return { type: "image", data: await codec.toBase64(file), mimeType: type };
    }
    const size = fitWithin(image.width, image.height);
    const jpeg = await codec.encodeJpeg(image, size.width, size.height, JPEG_QUALITY);
    if (jpeg.size > MAX_BYTES) throw new ImagePrepareError(`${file.name} is too large (over 5 MB)`);
    return { type: "image", data: await codec.toBase64(jpeg), mimeType: "image/jpeg" };
  } finally {
    image.close?.();
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the image"));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

async function decodeInBrowser(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      close: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight, source: img };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encodeInBrowser(
  image: DecodedImage,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Canvas unavailable"));
  // JPEG has no alpha: flatten transparency onto white rather than black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image.source, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Couldn't encode the image"))),
      "image/jpeg",
      quality,
    );
  });
}

export const browserCodec: ImageCodec = {
  decode: decodeInBrowser,
  encodeJpeg: encodeInBrowser,
  toBase64: blobToBase64,
};
