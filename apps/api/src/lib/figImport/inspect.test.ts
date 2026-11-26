import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deflateSync, zipSync } from "fflate";
import { ByteBuffer, compileSchema, encodeBinarySchema, parseSchema, type Schema } from "kiwi-schema";
import { parseFigBinary } from "openfig-core";
import { boundedImageHeader, readImageHeader } from "./assets.js";
import { zstdBounded } from "./inflate.js";
import { inspectFigFile } from "./worker.js";
import { nodeId } from "./nodeId.js";
import { compileSchemaSource } from "./schema.js";
import { FIG_LIMITS } from "./limits.js";
import {
  MINIMAL_SCHEMA,
  PNG_1X1,
  canvasFromRaw,
  duplicateCanvas,
  encodeMinimalMessage,
  openFigCanvas,
  oracleNodeId,
  patchCentralUncompressedSize,
  patchEntryCount,
  varints,
  zipFig,
} from "../../../test/figImportFixtures.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "fig-import-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function inspect(bytes: Uint8Array, name = "sample.fig") {
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return inspectFigFile(file, name);
}

const minimalNodes = [
  { guid: { sessionID: 0, localID: 0 }, type: "DOCUMENT", name: "Document" },
  { guid: { sessionID: 0, localID: 1 }, type: "CANVAS", name: "Page", parentIndex: { guid: { sessionID: 0, localID: 0 }, position: "a" } },
  { guid: { sessionID: 1, localID: 2 }, type: "FRAME", name: "Frame", size: { x: 100, y: 200 }, parentIndex: { guid: { sessionID: 0, localID: 1 }, position: "a" } },
];

const schemaWith = (text: string): Schema => parseSchema(text);
const rawWith = (schema: Schema, message: Record<string, unknown>) => (compileSchema(schema) as { encodeMessage(value: unknown): Uint8Array }).encodeMessage(message);

describe("bounded .fig inspection", () => {
  it("returns metadata, Page/Frame summaries, assets and decoder metrics without node text", async () => {
    const result = await inspect(zipFig({ "canvas.fig": openFigCanvas(), "images/a.png": PNG_1X1 }));
    expect(result.metadata).toMatchObject({ prelude: "fig-kiwi", version: 1, chunkCount: 2, zipEntries: 2 });
    expect(result.nodeCount).toBe(4);
    expect(result.pages).toEqual([{ id: "0:1", name: "Campaigns", frameCount: 1 }]);
    expect(result.frames).toEqual([{ id: "7:2", pageId: "0:1", name: "Launch", width: 1080, height: 1080 }]);
    expect(result.assets).toEqual([{ format: "png", bytes: PNG_1X1.length, width: 1, height: 1 }]);
    expect(result.metrics.decoder.operations).toBeGreaterThan(0);
    expect(result.metrics.decoder.invocations).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("PRIVATE TEXT MUST NOT ESCAPE");
  });

  it("matches OpenFig's raw parse for node, Page and Frame summaries", async () => {
    const canvas = openFigCanvas();
    const oracle = parseFigBinary(canvas);
    const result = await inspect(zipFig({ "canvas.fig": canvas }));
    expect(result.nodeCount).toBe(oracle.nodes.length);
    expect(result.pages.map((page) => page.id)).toEqual(oracle.nodes.filter((node) => node.type === "CANVAS").map((node) => oracleNodeId(node)!));
    expect(result.frames.map((frame) => frame.id)).toEqual(oracle.nodes.filter((node) => node.type === "FRAME").map((node) => oracleNodeId(node)!));
  });

  it("matches OpenFig's node id on valid nodes", () => {
    const node = { guid: { sessionID: 7, localID: 9 } };
    expect(nodeId(node)).toBe(oracleNodeId(node as never));
    expect(nodeId({})).toBeNull();
  });

  it("decodes a Zstandard message chunk through fzstd's streaming API", async () => {
    const result = await inspect(zipFig({ "canvas.fig": openFigCanvas(undefined, { zstd: true }) }));
    expect(result.nodeCount).toBe(4);
  });

  it("rejects an oversized Zstandard window before fzstd allocates it", () => {
    const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff]);
    expect(() => zstdBounded(header, FIG_LIMITS.messageBytes)).toThrowError(expect.objectContaining({ code: "FIG_LIMIT" }));
  });

  it("rejects ZIP path traversal even in an entry it would not extract", async () => {
    await expect(inspect(zipFig({ "canvas.fig": openFigCanvas(), "../escape.bin": new Uint8Array([1]) }))).rejects.toMatchObject({ code: "FIG_INVALID" });
  });

  it("rejects more than 2,000 central-directory entries", async () => {
    await expect(inspect(patchEntryCount(zipFig({ "canvas.fig": openFigCanvas() }), 2001))).rejects.toMatchObject({ code: "FIG_LIMIT" });
  });

  it("rejects duplicate canvas.fig entries", async () => {
    const zip = zipFig({ "canvas.fig": openFigCanvas(), "canvas.abc": new Uint8Array([1]) });
    await expect(inspect(duplicateCanvas(zip))).rejects.toMatchObject({ code: "FIG_INVALID" });
  });

  it("rejects a central-directory total above 192 MB before extraction", async () => {
    await expect(inspect(patchCentralUncompressedSize(zipFig({ "canvas.fig": openFigCanvas() }), 193_000_000))).rejects.toMatchObject({ code: "FIG_LIMIT" });
  });

  it("refuses DEFLATE for canvas.fig instead of guessing a higher peak budget", async () => {
    await expect(inspect(zipFig({ "canvas.fig": openFigCanvas() }, 9))).rejects.toMatchObject({ code: "FIG_UNSUPPORTED" });
  });

  it("rejects a truncated length-prefixed chunk", async () => {
    const canvas = openFigCanvas();
    await expect(inspect(zipFig({ "canvas.fig": canvas.subarray(0, canvas.length - 1) }))).rejects.toMatchObject({ code: "FIG_INVALID" });
  });

  it("rejects more than 32 chunks", async () => {
    const schema = schemaWith(MINIMAL_SCHEMA);
    const canvas = canvasFromRaw(schema, encodeMinimalMessage(schema, { nodeChanges: minimalNodes }), { extraChunks: Array.from({ length: 31 }, () => new Uint8Array()) });
    await expect(inspect(zipFig({ "canvas.fig": canvas }))).rejects.toMatchObject({ code: "FIG_LIMIT" });
  });

  it("caps decompressed schema bytes", async () => {
    const schema = schemaWith(MINIMAL_SCHEMA);
    const message = encodeMinimalMessage(schema, { nodeChanges: minimalNodes });
    const canvas = canvasFromRaw(schema, message, { schemaBytes: deflateSync(new Uint8Array(4_000_001)), messageBytes: deflateSync(message) });
    await expect(inspect(zipFig({ "canvas.fig": canvas }))).rejects.toMatchObject({ code: "FIG_LIMIT" });
  });

  it("caps decompressed message bytes", async () => {
    const schema = schemaWith(MINIMAL_SCHEMA);
    const message = encodeMinimalMessage(schema, { nodeChanges: minimalNodes });
    const canvas = canvasFromRaw(schema, message, { messageBytes: deflateSync(new Uint8Array(16_000_001)) });
    await expect(inspect(zipFig({ "canvas.fig": canvas }))).rejects.toMatchObject({ code: "FIG_LIMIT" });
  }, 20_000);

  it("stops a 50,001-item array before Kiwi allocates it", async () => {
    const schema = schemaWith("message Message { uint[] nodeChanges = 1; }");
    const canvas = canvasFromRaw(schema, varints(1, 50_001));
    await expect(inspect(zipFig({ "canvas.fig": canvas }))).rejects.toMatchObject({ code: "FIG_LIMIT" });
  });

  it("enforces the aggregate array-item budget", async () => {
    const fields = Array.from({ length: 9 }, (_, i) => `Empty[] f${i + 1} = ${i + 1};`).join(" ");
    const schema = schemaWith(`struct Empty {} message Message { ${fields} }`);
    const canvas = canvasFromRaw(schema, varints(...Array.from({ length: 9 }, (_, i) => [i + 1, 50_000]).flat()));
    await expect(inspect(zipFig({ "canvas.fig": canvas }))).rejects.toMatchObject({ code: "FIG_LIMIT" });
  });

  it("enforces the decoder invocation budget on kiwi's deprecated non-byte array path", async () => {
    const schema = schemaWith("struct Empty {} message Message { Empty[] values = 1 [deprecated]; }");
    const canvas = canvasFromRaw(schema, varints(1, 2_000_001));
    await expect(inspect(zipFig({ "canvas.fig": canvas }))).rejects.toMatchObject({ code: "FIG_LIMIT" });
  }, 20_000);

  it("enforces decoder invocation depth", async () => {
    const schema = schemaWith("message Message { Node nodeChanges = 1; } message Node { Node child = 1; }");
    let node: Record<string, unknown> = {};
    for (let i = 0; i < 33; i++) node = { child: node };
    const canvas = canvasFromRaw(schema, rawWith(schema, { nodeChanges: node }));
    await expect(inspect(zipFig({ "canvas.fig": canvas }))).rejects.toMatchObject({ code: "FIG_LIMIT" });
  });

  it("rejects more than 20,000 decoded nodes", async () => {
    const schema = schemaWith(MINIMAL_SCHEMA);
    const many = Array.from({ length: 20_001 }, (_, i) => ({ guid: { sessionID: 1, localID: i }, type: "FRAME", name: "F" }));
    const canvas = canvasFromRaw(schema, rawWith(schema, { nodeChanges: many }));
    await expect(inspect(zipFig({ "canvas.fig": canvas }))).rejects.toMatchObject({ code: "FIG_LIMIT" });
  });

  it("rejects dangerous schema definition names before code generation", async () => {
    const schema: Schema = { package: null, definitions: [{ name: "__proto__", kind: "MESSAGE", fields: [], line: 0, column: 0 }] };
    const canvas = canvasFromRaw(schema, new Uint8Array(), { schemaBytes: deflateSync(encodeBinarySchema(schema)), messageBytes: deflateSync(new Uint8Array()) });
    await expect(inspect(zipFig({ "canvas.fig": canvas }))).rejects.toMatchObject({ code: "FIG_INVALID" });
  });

  it("checks schema counts before kiwi allocates from them", () => {
    expect(() => compileSchemaSource(varints(2001))).toThrowError(expect.objectContaining({ code: "FIG_LIMIT" }));
  });

  it("accepts an own definition whose name is inherited on a plain object", () => {
    const schema = schemaWith("struct toString {} message Message { toString nodeChanges = 1; }");
    const source = compileSchemaSource(encodeBinarySchema(schema));
    expect(source.source.startsWith("var exports = exports || {};")).toBe(true);
  });

  it("streams a deflated image and reads only its header", async () => {
    const result = await inspect(zipSync({ "canvas.fig": openFigCanvas(), "images/a.png": [PNG_1X1, { level: 9 }] }, { level: 0 }));
    expect(result.assets[0]).toMatchObject({ format: "png", width: 1, height: 1 });
  });

  it("rejects an image whose actual deflated output exceeds its declared cap", async () => {
    const zip = zipSync({ "canvas.fig": openFigCanvas(), "images/a.png": [PNG_1X1, { level: 9 }] }, { level: 0 });
    await expect(inspect(patchCentralUncompressedSize(zip, 10, 1))).rejects.toMatchObject({ code: "FIG_LIMIT" });
  });

  it("reports unsupported image headers as warnings without decoding pixels", async () => {
    const result = await inspect(zipFig({ "canvas.fig": openFigCanvas(), "images/a.bin": new TextEncoder().encode("not an image") }));
    expect(result.assets[0]).toMatchObject({ format: null, width: null, height: null });
    expect(result.warnings.join(" ")).toContain("no pixels were decoded");
  });

  it("enforces per-image and aggregate megapixel limits from headers", async () => {
    const png = (width: number, height: number) => {
      const b = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
      b.write("IHDR", 12);
      b.writeUInt32BE(width, 16);
      b.writeUInt32BE(height, 20);
      return b;
    };
    expect(() => boundedImageHeader(readImageHeader(png(8193, 1)))).toThrowError(expect.objectContaining({ code: "FIG_LIMIT" }));
    const entries = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`images/${i}.png`, png(5000, 5000)]));
    await expect(inspect(zipFig({ "canvas.fig": openFigCanvas(), ...entries }))).rejects.toMatchObject({ code: "FIG_LIMIT" });
  });
});

describe("image headers", () => {
  it("reads PNG, GIF, WebP and JPEG dimensions without an image decoder", () => {
    expect(readImageHeader(PNG_1X1)).toEqual({ format: "png", width: 1, height: 1 });
    const gif = Buffer.from("GIF89a\x10\x00\x20\x00\x00\x00\x00", "ascii");
    expect(readImageHeader(gif)).toEqual({ format: "gif", width: 16, height: 32 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0); webp.write("WEBP", 8); webp.write("VP8X", 12); webp.writeUInt32LE(10, 16);
    webp[24] = 99; webp[27] = 49;
    expect(readImageHeader(webp)).toEqual({ format: "webp", width: 100, height: 50 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x40, 0x00, 0x80]);
    expect(readImageHeader(jpeg)).toEqual({ format: "jpeg", width: 128, height: 64 });
  });
});
