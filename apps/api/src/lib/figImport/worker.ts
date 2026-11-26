import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { boundedImageHeader, readImageHeader } from "./assets.js";
import { createGuardedDecoder } from "./decoder.js";
import { inflateBounded, zstdBounded } from "./inflate.js";
import { FIG_LIMITS, FigError, fail } from "./limits.js";
import { nodeId } from "./nodeId.js";
import { compileSchemaSource } from "./schema.js";
import type { FigFrameSummary, FigInspection, FigPageSummary } from "./types.js";
import { deflatedPrefix, parseZipDirectory, storedEntry, storedPrefix, type ZipArchive } from "./zip.js";

async function readBoundedFile(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > FIG_LIMITS.uploadBytes) fail("FIG_TOO_LARGE", 413);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail("FIG_INVALID");
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function canvasChunks(canvas: Uint8Array): { prelude: string; version: number; chunks: Uint8Array[] } {
  if (canvas.length < 16) fail("FIG_INVALID");
  const prelude = String.fromCharCode(...canvas.subarray(0, 8));
  if (!prelude.startsWith("fig-") || /[^\x20-\x7e]/.test(prelude)) fail("FIG_INVALID");
  const view = new DataView(canvas.buffer, canvas.byteOffset, canvas.byteLength);
  const version = view.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  let offset = 12;
  while (offset < canvas.length) {
    if (offset + 4 > canvas.length || chunks.length >= FIG_LIMITS.chunks) fail("FIG_LIMIT");
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length > canvas.length - offset) fail("FIG_INVALID");
    chunks.push(canvas.subarray(offset, offset + length));
    offset += length;
  }
  if (chunks.length < 2) fail("FIG_INVALID");
  return { prelude: prelude.trim(), version, chunks };
}

interface NodeInfo {
  id: string;
  type: string;
  name: string;
  parentId: string | null;
  width: number | null;
  height: number | null;
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null ? value as Record<string, unknown> : null);
const label = (value: unknown): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "Untitled");
const dimension = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

function nodes(message: Record<string, unknown>, warnings: string[]): NodeInfo[] {
  if (!Array.isArray(message.nodeChanges) || message.nodeChanges.length > FIG_LIMITS.nodes) fail("FIG_LIMIT");
  const out: NodeInfo[] = [];
  const ids = new Set<string>();
  for (const raw of message.nodeChanges) {
    const node = record(raw);
    const id = nodeId(node);
    if (!node || !id || ids.has(id)) fail("FIG_INVALID");
    ids.add(id);
    const type = typeof node.type === "string" && node.type.length <= 64 ? node.type : "UNKNOWN";
    const parent = record(node.parentIndex);
    const size = record(node.size);
    out.push({ id, type, name: label(node.name), parentId: nodeId(parent), width: dimension(size?.x), height: dimension(size?.y) });
  }
  if (out.some((node) => node.type === "UNKNOWN")) warnings.push("Some nodes have no recognised type and were counted but not summarised.");
  return out;
}

function summaries(all: NodeInfo[], warnings: string[]): { pages: FigPageSummary[]; frames: FigFrameSummary[] } {
  const byId = new Map(all.map((node) => [node.id, node]));
  const pages: FigPageSummary[] = all.filter((node) => node.type === "CANVAS").map((node) => ({ id: node.id, name: node.name, frameCount: 0 }));
  const pageIds = new Set(pages.map((page) => page.id));
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const frames: FigFrameSummary[] = [];
  let orphaned = false;
  for (const node of all) {
    if (node.type !== "FRAME") continue;
    let current: NodeInfo | undefined = node;
    const seen = new Set<string>();
    let steps = 0;
    while (current && !pageIds.has(current.id) && steps++ < 256) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (!current || !pageIds.has(current.id)) {
      orphaned = true;
      continue;
    }
    const page = pageById.get(current.id)!;
    page.frameCount++;
    frames.push({ id: node.id, pageId: page.id, name: node.name, width: node.width, height: node.height });
  }
  if (orphaned) warnings.push("Some frames have no reachable Page and were omitted from the frame summary.");
  return { pages, frames };
}

function assets(archive: ZipArchive, warnings: string[]): { list: FigInspection["assets"]; bytes: number; pixels: number } {
  const list: FigInspection["assets"] = [];
  let bytes = 0;
  let pixels = 0;
  let unsupported = 0;
  for (const entry of archive.entries) {
    if (!entry.name.startsWith("images/") || entry.name.endsWith("/")) continue;
    const prefix = entry.method === 0 ? storedPrefix(archive, entry, FIG_LIMITS.imageHeaderBytes) : deflatedPrefix(archive, entry, FIG_LIMITS.imageHeaderBytes);
    const header = boundedImageHeader(readImageHeader(prefix));
    if (!header) unsupported++;
    else pixels += header.width * header.height;
    if (pixels > FIG_LIMITS.imageTotalPixels) fail("FIG_LIMIT");
    bytes += entry.uncompressedSize;
    list.push({ format: header?.format ?? null, bytes: entry.uncompressedSize, width: header?.width ?? null, height: header?.height ?? null });
  }
  if (unsupported) warnings.push(`${unsupported} embedded image(s) have an unsupported or unreadable header; no pixels were decoded.`);
  return { list, bytes, pixels };
}

export async function inspectFigFile(filePath: string, sourceName = "upload.fig"): Promise<FigInspection> {
  try {
    return await inspectFigFileUnsafe(filePath, sourceName);
  } catch (error) {
    if (error instanceof FigError) throw error;
    fail("FIG_INVALID");
  }
}

async function inspectFigFileUnsafe(filePath: string, sourceName: string): Promise<FigInspection> {
  const started = performance.now();
  const zipBytes = await readBoundedFile(filePath);
  const archive = parseZipDirectory(zipBytes);
  const canvasEntry = archive.entries.find((entry) => entry.name === "canvas.fig")!;
  const canvas = storedEntry(archive, canvasEntry);
  const header = canvasChunks(canvas);
  const warnings: string[] = [];
  if (header.chunks.length > 2) warnings.push("Additional Figma chunks were not decoded.");
  const schemaData = inflateBounded(header.chunks[0], FIG_LIMITS.schemaBytes).bytes;
  const messageChunk = header.chunks[1];
  const messageData = messageChunk[0] === 0x28 && messageChunk[1] === 0xb5 && messageChunk[2] === 0x2f && messageChunk[3] === 0xfd
    ? zstdBounded(messageChunk, FIG_LIMITS.messageBytes).bytes
    : inflateBounded(messageChunk, FIG_LIMITS.messageBytes).bytes;
  const compiled = compileSchemaSource(schemaData);
  const decoder = createGuardedDecoder(compiled.source);
  const decoded = record(decoder.decodeMessage(messageData));
  if (!decoded) fail("FIG_INVALID");
  const allNodes = nodes(decoded, warnings);
  const summary = summaries(allNodes, warnings);
  const assetSummary = assets(archive, warnings);
  const cleanName = String(sourceName).split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) || "upload.fig";
  return {
    fileName: cleanName,
    metadata: {
      prelude: header.prelude,
      version: header.version,
      chunkCount: header.chunks.length,
      zipEntries: archive.entries.length,
      zipBytes: zipBytes.length,
      canvasBytes: canvas.length,
    },
    pages: summary.pages,
    frames: summary.frames,
    nodeCount: allNodes.length,
    assets: assetSummary.list,
    metrics: {
      schemaBytes: schemaData.length,
      messageBytes: messageData.length,
      assetBytes: assetSummary.bytes,
      assetPixels: assetSummary.pixels,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      decoder: decoder.metrics(),
    },
    warnings,
  };
}
