// Canvas asset routes (phase 2): privacy headers, workspace isolation, fail-closed storage, and that the
// storage path never reaches a client. Real LocalDiskStorage over a temp directory; prisma and auth are mocked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  authed: true,
  workspace: "ws-1" as string | null,
  rows: [] as Array<{ id: string; workspaceId: string; storageRef: string }>,
  createFails: false,
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    designAsset: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (h.createFails) throw new Error("db down");
        const row = { id: `asset-${h.rows.length + 1}`, ...data } as { id: string; workspaceId: string; storageRef: string };
        h.rows.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; workspaceId: string } }) =>
        h.rows.find((r) => r.id === where.id && r.workspaceId === where.workspaceId) ?? null,
      ),
    },
  },
}));
vi.mock("../lib/auth/withAuth.js", () => ({
  withAuth: async (_req: unknown, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!h.authed) return reply.status(401).send({ error: "Unauthorized" });
  },
  getUser: () => ({ id: "user-1" }),
  getWorkspaceId: () => {
    if (!h.workspace) throw new Error("no workspace");
    return h.workspace;
  },
}));

import { canvasRoutes } from "./canvas.js";
import { LocalDiskStorage } from "../lib/storage.js";

let dir: string;
let app: FastifyInstance;
let storage: LocalDiskStorage;

const png = () => sharp({ create: { width: 12, height: 8, channels: 3, background: "#ff5c00" } }).png().toBuffer();

/** A multipart body with one file field, built by hand so the test needs no form-data dependency. */
function upload(file: Buffer, filename = "a.png", type = "image/png") {
  const boundary = "----canvastest";
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const payload = Buffer.concat([head, file, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { method: "POST" as const, url: "/canvas/assets", payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function build(s: LocalDiskStorage | object): Promise<FastifyInstance> {
  const a = Fastify();
  await a.register(multipart);
  await a.register(canvasRoutes, { storage: s } as never);
  await a.ready();
  return a;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-routes-"));
  storage = new LocalDiskStorage(dir);
  app = await build(storage);
});
afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  h.authed = true;
  h.workspace = "ws-1";
  h.rows = [];
  h.createFails = false;
});

describe("POST /canvas/assets", () => {
  it("stores a PNG privately and answers with an API-relative url, never the storage path", async () => {
    const res = await app.inject(upload(await png()));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({ id: "asset-1", width: 12, height: 8, url: "/canvas/assets/asset-1/content" });

    const ref = h.rows[0].storageRef;
    expect(ref).toMatch(/^\/uploads\/\.canvas-private\/ws-1\/[\w-]+\.png$/);
    expect(fs.existsSync(path.join(dir, ref.replace(/^\/uploads\//, "")))).toBe(true);
    const text = res.body;
    expect(text).not.toContain("storageRef");
    expect(text).not.toContain(".canvas-private");
    expect(text).not.toContain("/uploads/");
    expect(body.url).not.toMatch(/^https?:|\/api\//);
  });

  it("imports an SVG as one PNG layer", async () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#FF5C00"/></svg>`);
    const res = await app.inject(upload(svg, "logo.svg", "image/svg+xml"));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ width: 3072, height: 1536 });
  });

  it("rejects a non-PNG renamed .png, and stores nothing", async () => {
    const folder = path.join(dir, ".canvas-private", "ws-1");
    const count = () => (fs.existsSync(folder) ? fs.readdirSync(folder).length : 0);
    await app.inject(upload(await png())); // earlier tests share this folder, so compare before and after
    const before = count();
    h.rows = [];

    const res = await app.inject(upload(Buffer.from("<html><script>alert(1)</script></html>"), "evil.png", "image/png"));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "ASSET_REJECTED" });
    expect(h.rows).toHaveLength(0);
    expect(count()).toBe(before);
  });

  it("names the offending SVG element", async () => {
    const res = await app.inject(upload(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>1</script></svg>`), "a.svg", "image/svg+xml"));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("<script>");
  });

  it("answers 400 when no file is sent", async () => {
    const res = await app.inject({ method: "POST", url: "/canvas/assets", payload: "", headers: { "content-type": "multipart/form-data; boundary=x" } });
    expect(res.statusCode).toBe(400);
  });

  it("answers 401 when unauthenticated, before reading the body", async () => {
    h.authed = false;
    const res = await app.inject(upload(await png()));
    expect(res.statusCode).toBe(401);
    expect(h.rows).toHaveLength(0);
  });

  it("removes the stored file when the database insert fails", async () => {
    const folder = path.join(dir, ".canvas-private", "ws-1");
    const count = () => (fs.existsSync(folder) ? fs.readdirSync(folder).length : 0);
    await app.inject(upload(await png())); // a successful upload first, so the folder exists and the count is not trivially 0
    const before = count();
    expect(before).toBeGreaterThan(0);

    h.createFails = true;
    const res = await app.inject(upload(await png()));
    expect(res.statusCode).toBe(500);
    expect(count()).toBe(before); // the failed upload's file was removed, not orphaned
  });
});

describe("GET /canvas/assets/:id/content", () => {
  async function seed(workspaceId = "ws-1") {
    const bytes = await png();
    const storageRef = await storage.upload(bytes, "image/png", `.canvas-private/${workspaceId}`);
    h.rows.push({ id: "a1", workspaceId, storageRef });
    return bytes;
  }

  it("serves the bytes with private, no-store headers and no validators", async () => {
    const bytes = await seed();
    const res = await app.inject({ method: "GET", url: "/canvas/assets/a1/content" });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(res.headers).not.toHaveProperty("etag");
    expect(res.headers).not.toHaveProperty("last-modified");
    expect(String(res.headers["cache-control"])).not.toMatch(/max-age|immutable|public/);
  });

  it("answers 404 for an asset in another workspace, with nothing about it", async () => {
    await seed("ws-2");
    const res = await app.inject({ method: "GET", url: "/canvas/assets/a1/content" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("ws-2");
    expect(res.body).not.toContain("canvas-private");
  });

  it("answers 404 for an unknown id", async () => {
    expect((await app.inject({ method: "GET", url: "/canvas/assets/nope/content" })).statusCode).toBe(404);
  });

  it("answers 404 when the row exists but the file is gone", async () => {
    h.rows.push({ id: "a1", workspaceId: "ws-1", storageRef: "/uploads/.canvas-private/ws-1/missing.png" });
    expect((await app.inject({ method: "GET", url: "/canvas/assets/a1/content" })).statusCode).toBe(404);
  });

  it("answers 401 when unauthenticated", async () => {
    await seed();
    h.authed = false;
    const res = await app.inject({ method: "GET", url: "/canvas/assets/a1/content" });
    expect(res.statusCode).toBe(401);
    expect(res.rawPayload.length).toBeLessThan(100);
  });
});

describe("upload, then download (LocalDiskStorage, no seeding)", () => {
  it("a PNG posted to the API is stored privately and comes back as the same valid PNG, to a member only", async () => {
    // 1. Upload through the real route.
    const posted = await app.inject(upload(await png()));
    expect(posted.statusCode).toBe(201);
    const asset = posted.json();
    expect(asset).toEqual({ id: "asset-1", width: 12, height: 8, url: "/canvas/assets/asset-1/content" });

    // 2. Nothing about where the file lives reaches the client.
    const storageRef = h.rows[0].storageRef;
    const storedName = path.basename(storageRef);
    for (const secret of [storageRef, storedName, ".canvas-private", "/uploads/", "storageRef"]) {
      expect(posted.body, secret).not.toContain(secret);
    }

    // 3. The file really is under the private directory, for this workspace, and holds a PNG.
    expect(storageRef).toMatch(/^\/uploads\/\.canvas-private\/ws-1\/[\w-]+\.png$/);
    const onDisk = path.join(dir, storageRef.replace(/^\/uploads\//, ""));
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);

    // 4. An authenticated member fetches it with the url the API returned, and gets valid PNG bytes.
    const got = await app.inject({ method: "GET", url: asset.url });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["cache-control"]).toBe("private, no-store");
    expect(got.rawPayload.equals(fs.readFileSync(onDisk))).toBe(true);
    expect(await sharp(got.rawPayload).metadata()).toMatchObject({ format: "png", width: 12, height: 8 });

    // 5. The same url gives nothing to a signed-out caller or to another workspace.
    h.authed = false;
    const signedOut = await app.inject({ method: "GET", url: asset.url });
    expect(signedOut.statusCode).toBe(401);
    expect(signedOut.rawPayload.length).toBeLessThan(100);
    h.authed = true;
    h.workspace = "ws-2";
    const otherWorkspace = await app.inject({ method: "GET", url: asset.url });
    expect(otherWorkspace.statusCode).toBe(404);
    expect(otherWorkspace.rawPayload.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });
});

describe("fail closed on storage that is not local disk", () => {
  it("answers 501 before auth, the database or storage are touched", async () => {
    const other = { upload: vi.fn(), getBuffer: vi.fn(), delete: vi.fn(), listFolder: vi.fn(), ownsUrl: vi.fn() };
    const closed = await build(other);
    h.authed = false; // proves the refusal does not depend on a session either
    h.rows.push({ id: "a1", workspaceId: "ws-1", storageRef: "https://cdn.example/x.png" });

    const post = await closed.inject(upload(await png()));
    const get = await closed.inject({ method: "GET", url: "/canvas/assets/a1/content" });
    await closed.close();

    for (const res of [post, get]) {
      expect(res.statusCode).toBe(501);
      expect(res.json()).toMatchObject({ code: "CANVAS_STORAGE_UNSUPPORTED" });
      expect(res.body).toMatch(/STORAGE_PROVIDER=local/);
    }
    expect(other.upload).not.toHaveBeenCalled();
    expect(other.getBuffer).not.toHaveBeenCalled();
    expect(other.delete).not.toHaveBeenCalled();
  });
});
