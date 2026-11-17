// The public /uploads/ route serves dotfiles by default, so allowedPath is the only thing keeping Canvas's private
// folder off the web. This registers the same options index.ts uses, over a temp directory outside the repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import staticFiles from "@fastify/static";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CANVAS_PRIVATE_DIR, publicUploadsStatic } from "./canvasAssets.js";
import { LocalDiskStorage } from "./storage.js";

const SECRET = Buffer.from("PRIVATE-CANVAS-BYTES");
const PUBLIC = Buffer.from("PUBLIC-UPLOAD-BYTES");

let root: string;
let app: FastifyInstance;
let privateUrl: string; // what storage.upload() really returns for a Canvas asset
let publicUrl: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-static-"));
  const storage = new LocalDiskStorage(root);
  privateUrl = await storage.upload(SECRET, "image/png", `${CANVAS_PRIVATE_DIR}/ws-1`);
  publicUrl = await storage.upload(PUBLIC, "image/png");
  app = Fastify();
  await app.register(staticFiles, publicUploadsStatic(root));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const get = (url: string) => app.inject({ method: "GET", url });

describe("/uploads/ static route", () => {
  it("still serves a normal upload", async () => {
    const res = await get(publicUrl);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PUBLIC)).toBe(true);
  });

  it("the real private storage ref is on disk, and not served", async () => {
    expect(privateUrl).toMatch(/^\/uploads\/\.canvas-private\/ws-1\/[\w-]+\.png$/);
    expect(fs.existsSync(path.join(root, privateUrl.replace(/^\/uploads\//, "")))).toBe(true);
    const res = await get(privateUrl);
    expect(res.statusCode).toBe(404);
    expect(res.rawPayload.includes(SECRET)).toBe(false);
  });

  const file = (p: string) => p.replace("/uploads/.canvas-private/", "");
  it.each([
    ["percent-encoded dot", (p: string) => `/uploads/%2Ecanvas-private/${file(p)}`],
    ["percent-encoded dot, lower case hex", (p: string) => `/uploads/%2ecanvas-private/${file(p)}`],
    ["fully percent-encoded folder", (p: string) => `/uploads/${encodeURIComponent(".canvas-private").replace(/-/g, "%2D")}/${file(p)}`],
    ["upper case", (p: string) => `/uploads/.CANVAS-PRIVATE/${file(p)}`],
    ["mixed case", (p: string) => `/uploads/.Canvas-Private/${file(p)}`],
    ["trailing dot", (p: string) => `/uploads/.canvas-private./${file(p)}`],
    ["backslash separator", (p: string) => `/uploads/.canvas-private%5C${file(p)}`],
    ["dot segment before it", (p: string) => `/uploads/x/../.canvas-private/${file(p)}`],
    ["encoded dot segment", (p: string) => `/uploads/x/%2e%2e/.canvas-private/${file(p)}`],
    ["double slash", (p: string) => `/uploads//.canvas-private/${file(p)}`],
    ["traversal out of a public folder", (p: string) => `/uploads/profile-pics/../.canvas-private/${file(p)}`],
  ])("never serves the private folder: %s", async (_name, build) => {
    const res = await get(build(privateUrl));
    expect(res.statusCode).not.toBe(200);
    expect(res.rawPayload.includes(SECRET)).toBe(false);
  });

  it("answers 404 for the plain, encoded, mixed-case and traversal forms", async () => {
    for (const url of [
      privateUrl,
      privateUrl.replace(".canvas-private", "%2Ecanvas-private"),
      privateUrl.replace(".canvas-private", ".Canvas-Private"),
      privateUrl.replace("/uploads/", "/uploads/x/../"),
    ]) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
  });

  it("the directory itself is not listed or served", async () => {
    for (const url of ["/uploads/.canvas-private", "/uploads/.canvas-private/", "/uploads/.canvas-private/ws-1/"]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
    }
  });
});

describe("control: without allowedPath", () => {
  // Proves the tests above are not vacuous and that the guard, not @fastify/static, is what protects the folder.
  it("the same plugin serves the private file", async () => {
    const bare = Fastify();
    await bare.register(staticFiles, { root, prefix: "/uploads/" });
    await bare.ready();
    const res = await bare.inject({ method: "GET", url: privateUrl });
    await bare.close();
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(SECRET)).toBe(true);
  });
});

describe("index.ts", () => {
  it("registers the guarded static options, not a bare { root, prefix }", () => {
    const source = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(source).toContain("staticFiles, publicUploadsStatic(UPLOADS_DIR)");
    expect(source).not.toMatch(/staticFiles,\s*\{\s*root/);
  });
});
