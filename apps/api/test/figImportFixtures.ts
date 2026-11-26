import zlib from "node:zlib";
import { deflateSync, zipSync } from "fflate";
import { assembleCanvasFig, createEmptyFigDoc, nodeId as oracleNodeId, type FigDocument, type FigNode } from "openfig-core";
import { ByteBuffer, compileSchema, encodeBinarySchema, type Schema } from "kiwi-schema";

const zstdCompressSync = (zlib as unknown as { zstdCompressSync(data: Uint8Array): Uint8Array }).zstdCompressSync;
let emptyDoc: FigDocument | undefined;

export const MINIMAL_SCHEMA = `
struct Guid { int sessionID; int localID; }
struct ParentIndex { Guid guid; string position; }
struct Size { float x; float y; }
message NodeChange { Guid guid = 1; string type = 2; string name = 3; ParentIndex parentIndex = 4; Size size = 5; }
message Message { NodeChange[] nodeChanges = 1; }
`;

export function canvasFromRaw(schema: Schema, message: Uint8Array, options: { zstd?: boolean; schemaBytes?: Uint8Array; messageBytes?: Uint8Array; extraChunks?: Uint8Array[] } = {}): Uint8Array {
  return assembleCanvasFig({
    prelude: "fig-kiwi",
    version: 1,
    schemaCompressed: options.schemaBytes ?? deflateSync(encodeBinarySchema(schema)),
    messageCompressed: options.messageBytes ?? (options.zstd ? zstdCompressSync(message) : deflateSync(message)),
    passThrough: options.extraChunks,
  });
}

export function encodeMinimalMessage(schema: Schema, message: Record<string, unknown>): Uint8Array {
  return (compileSchema(schema) as { encodeMessage(value: unknown): Uint8Array }).encodeMessage(message);
}

export function zipFig(entries: Record<string, Uint8Array>, level: 0 | 6 | 9 = 0): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, [bytes, { level }]])), { level });
}

export function openFigCanvas(nodes?: FigNode[], options: { zstd?: boolean } = {}): Uint8Array {
  emptyDoc ??= createEmptyFigDoc();
  const doc = emptyDoc;
  const message = {
    ...doc.message,
    nodeChanges: nodes ?? [
      { guid: { sessionID: 0, localID: 0 }, type: "DOCUMENT", name: "Document" },
      { guid: { sessionID: 0, localID: 1 }, type: "CANVAS", name: "Campaigns", parentIndex: { guid: { sessionID: 0, localID: 0 }, position: "a" } },
      { guid: { sessionID: 7, localID: 2 }, type: "FRAME", name: "Launch", size: { x: 1080, y: 1080 }, parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "a" } },
      { guid: { sessionID: 7, localID: 3 }, type: "TEXT", name: "Headline", textData: { characters: "PRIVATE TEXT MUST NOT ESCAPE" }, parentIndex: { guid: { sessionID: 7, localID: 2 }, position: "a" } },
    ],
  };
  return canvasFromRaw(doc.schema, (doc.compiledSchema as { encodeMessage(value: unknown): Uint8Array }).encodeMessage(message), options);
}

export function varints(...values: number[]): Uint8Array {
  const bb = new ByteBuffer();
  for (const value of values) bb.writeVarUint(value);
  return bb.toUint8Array();
}

export function patchCentralUncompressedSize(zip: Uint8Array, size: number, entryIndex = 0): Uint8Array {
  const copy = Buffer.from(zip);
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let at = copy.indexOf(signature);
  for (let i = 0; i < entryIndex && at >= 0; i++) at = copy.indexOf(signature, at + 4);
  if (at < 0) throw new Error("central directory not found");
  copy.writeUInt32LE(size, at + 24);
  return copy;
}

export function patchEntryCount(zip: Uint8Array, count: number): Uint8Array {
  const copy = Buffer.from(zip);
  const at = copy.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (at < 0) throw new Error("EOCD not found");
  copy.writeUInt16LE(count, at + 10);
  return copy;
}

export function duplicateCanvas(zip: Uint8Array): Uint8Array {
  const copy = Buffer.from(zip);
  const name = Buffer.from("canvas.abc");
  let at = copy.indexOf(name);
  if (at < 0) throw new Error("second entry not found");
  while (at >= 0) {
    Buffer.from("canvas.fig").copy(copy, at);
    at = copy.indexOf(name, at + name.length);
  }
  return copy;
}

export const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nWQAAAAASUVORK5CYII=", "base64");
export { oracleNodeId };
