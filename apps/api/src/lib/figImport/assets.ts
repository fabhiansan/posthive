import { FIG_LIMITS, fail } from "./limits.js";

export type ImageFormat = "png" | "jpeg" | "webp" | "gif";
export interface ImageHeader {
  format: ImageFormat;
  width: number;
  height: number;
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const four = (b: Uint8Array, at: number, value: string) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]) === value;

/** Header only: no image decoder is loaded and no pixel buffer is allocated. */
export function readImageHeader(b: Uint8Array): ImageHeader | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && four(b, 12, "IHDR")) {
    return { format: "png", width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 13 && four(b, 0, "GIF8") && b[5] === 0x61 && ((b[4] === 0x37) || (b[4] === 0x39))) {
    return { format: "gif", width: u16(b, 6), height: u16(b, 8) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= b.length) {
      if (b[at] !== 0xff) return null;
      while (at < b.length && b[at] === 0xff) at++;
      const marker = b[at++];
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || marker === 0xd8) continue;
      if (at + 2 > b.length) return null;
      const length = u16be(b, at);
      if (length < 2 || at + length > b.length) return null;
      if ((marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) && length >= 7) {
        return { format: "jpeg", width: u16be(b, at + 5), height: u16be(b, at + 3) };
      }
      at += length;
    }
    return null;
  }
  if (b.length >= 30 && four(b, 0, "RIFF") && four(b, 8, "WEBP")) {
    let at = 12;
    while (at + 8 <= b.length) {
      const kind = String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
      const size = u32le(b, at + 4);
      const data = at + 8;
      if (data + size > b.length) return null;
      if (kind === "VP8X" && size >= 10) return { format: "webp", width: u24(b, data + 4) + 1, height: u24(b, data + 7) + 1 };
      if (kind === "VP8L" && size >= 5 && b[data] === 0x2f) {
        const packed = u32le(b, data + 1);
        return { format: "webp", width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
      }
      if (kind === "VP8 " && size >= 10 && b[data + 3] === 0x9d && b[data + 4] === 0x01 && b[data + 5] === 0x2a) {
        return { format: "webp", width: u16(b, data + 6) & 0x3fff, height: u16(b, data + 8) & 0x3fff };
      }
      at = data + size + (size & 1);
    }
  }
  return null;
}

export function boundedImageHeader(header: ImageHeader | null): ImageHeader | null {
  if (!header) return null;
  if (!Number.isSafeInteger(header.width) || !Number.isSafeInteger(header.height) || header.width < 1 || header.height < 1) fail("FIG_INVALID");
  if (header.width > FIG_LIMITS.imageSide || header.height > FIG_LIMITS.imageSide || header.width * header.height > FIG_LIMITS.imagePixels) fail("FIG_LIMIT");
  return header;
}
