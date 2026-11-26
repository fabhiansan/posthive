import { FIG_LIMITS, fail } from "./limits.js";
import { inflateBounded } from "./inflate.js";

export interface ZipEntry {
  name: string;
  flags: number;
  method: 0 | 8;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

export interface ZipArchive {
  bytes: Uint8Array;
  entries: ZipEntry[];
  centralOffset: number;
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const decodeName = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("FIG_INVALID");
  }
};

function safeName(name: string): void {
  if (!name || name.length > 512 || name.includes("\0") || name.includes("\\") || name.includes(":") || name.startsWith("/")) fail("FIG_INVALID");
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    if (!(parts.at(-1) === "" && parts.length > 1 && parts.slice(0, -1).every((part) => part && part !== "." && part !== ".."))) fail("FIG_INVALID");
  }
}

/** Reads only the bounded central directory. Nothing from an archive is ever written to a path it names. */
export function parseZipDirectory(bytes: Uint8Array): ZipArchive {
  if (bytes.length < 22) fail("FIG_INVALID");
  let eocd = -1;
  const first = Math.max(0, bytes.length - 22 - 65_535);
  for (let at = bytes.length - 22; at >= first; at--) {
    if (u32(bytes, at) === 0x06054b50 && at + 22 + u16(bytes, at + 20) === bytes.length) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0 || u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0) fail("FIG_INVALID");
  const count = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  if (count === 0 || count > FIG_LIMITS.zipEntries || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail("FIG_LIMIT");
  if (centralOffset + centralSize !== eocd || centralOffset > bytes.length || centralSize > bytes.length) fail("FIG_INVALID");

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  const localOffsets = new Set<number>();
  let total = 0;
  let images = 0;
  let canvas: ZipEntry | undefined;
  let at = centralOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || u32(bytes, at) !== 0x02014b50) fail("FIG_INVALID");
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const compressedSize = u32(bytes, at + 20);
    const uncompressedSize = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const localOffset = u32(bytes, at + 42);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || nameLength === 0 || flags & 0x0041 || (method !== 0 && method !== 8)) fail("FIG_INVALID");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) fail("FIG_LIMIT");
    const name = decodeName(bytes.subarray(at + 46, at + 46 + nameLength));
    safeName(name);
    if (names.has(name) || localOffsets.has(localOffset)) fail("FIG_INVALID");
    names.add(name);
    localOffsets.add(localOffset);
    if (uncompressedSize > FIG_LIMITS.zipEntryBytes || total + uncompressedSize > FIG_LIMITS.zipTotalBytes) fail("FIG_LIMIT");
    total += uncompressedSize;
    const entry: ZipEntry = { name, flags, method, compressedSize, uncompressedSize, localOffset };
    entries.push(entry);
    if (name === "canvas.fig") {
      if (canvas || method !== 0 || uncompressedSize > FIG_LIMITS.canvasBytes || compressedSize !== uncompressedSize) {
        fail(method === 8 ? "FIG_UNSUPPORTED" : "FIG_LIMIT");
      }
      canvas = entry;
    } else if (name.startsWith("images/") && !name.endsWith("/")) {
      if (++images > FIG_LIMITS.images || uncompressedSize > FIG_LIMITS.imageBytes) fail("FIG_LIMIT");
      if (method === 0 && compressedSize !== uncompressedSize) fail("FIG_INVALID");
    }
    at = end;
  }
  if (at !== eocd || !canvas) fail("FIG_INVALID");
  return { bytes, entries, centralOffset };
}

interface LocalEntry {
  dataOffset: number;
  entry: ZipEntry;
}

function localEntry(archive: ZipArchive, entry: ZipEntry): LocalEntry {
  const b = archive.bytes;
  const at = entry.localOffset;
  if (at + 30 > archive.centralOffset || u32(b, at) !== 0x04034b50) fail("FIG_INVALID");
  const flags = u16(b, at + 6);
  const method = u16(b, at + 8);
  const nameLength = u16(b, at + 26);
  const extraLength = u16(b, at + 28);
  const dataOffset = at + 30 + nameLength + extraLength;
  if (flags !== entry.flags || method !== entry.method || dataOffset > archive.centralOffset) fail("FIG_INVALID");
  if (decodeName(b.subarray(at + 30, at + 30 + nameLength)) !== entry.name) fail("FIG_INVALID");
  if (dataOffset + entry.compressedSize > archive.centralOffset) fail("FIG_INVALID");
  return { dataOffset, entry };
}

/** A zero-copy view; the ZIP buffer remains the owner and is already bounded by the upload cap. */
export function storedEntry(archive: ZipArchive, entry: ZipEntry): Uint8Array {
  const local = localEntry(archive, entry);
  if (entry.method !== 0 || entry.compressedSize !== entry.uncompressedSize) fail("FIG_INVALID");
  return archive.bytes.subarray(local.dataOffset, local.dataOffset + entry.uncompressedSize);
}

export function storedPrefix(archive: ZipArchive, entry: ZipEntry, max: number): Uint8Array {
  return storedEntry(archive, entry).subarray(0, max);
}

/** Streams a deflated image through the exact declared cap, retaining only its header. */
export function deflatedPrefix(archive: ZipArchive, entry: ZipEntry, max: number): Uint8Array {
  const local = localEntry(archive, entry);
  if (entry.method !== 8) fail("FIG_INVALID");
  const input = archive.bytes.subarray(local.dataOffset, local.dataOffset + entry.compressedSize);
  const header: Uint8Array[] = [];
  let kept = 0;
  const result = inflateBounded(input, entry.uncompressedSize, (chunk) => {
    if (kept < max) {
      const part = chunk.subarray(0, Math.min(chunk.length, max - kept));
      header.push(part);
      kept += part.length;
    }
  });
  if (result.bytes.length !== entry.uncompressedSize) fail("FIG_INVALID");
  const out = new Uint8Array(kept);
  let offset = 0;
  for (const part of header) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
