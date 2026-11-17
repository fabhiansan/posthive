// Canvas routes. Assets (phase 2): privacy headers, workspace isolation, fail-closed storage, and that the storage
// path never reaches a client. Designs (phase 3): designer-only access, workspace isolation, strict validation,
// the optimistic lock. Real LocalDiskStorage over a temp directory; prisma and auth are mocked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface DesignRow {
  id: string;
  workspaceId: string;
  kind: string;
  name: string;
  document: unknown;
  version: number;
  createdByUserId: string | null;
  updatedAt: Date;
}

const h = vi.hoisted(() => ({
  authed: true,
  workspace: "ws-1" as string | null,
  role: "designer" as string | null,
  rows: [] as Array<{ id: string; workspaceId: string; storageRef: string }>,
  designs: [] as DesignRow[],
  clock: 0,
  createFails: false,
}));

type Where = { id?: string; workspaceId?: string; kind?: string; version?: number };
const matches = (d: DesignRow, w: Where) => {
  // PostgreSQL refuses a NUL in text (error 22021) and Prisma throws it: a test double that quietly matched nothing
  // would hide a 500 that the real database causes. Checked against the real dev database.
  if (w.id?.includes("\u0000")) throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
  return (w.id === undefined || d.id === w.id) && (w.workspaceId === undefined || d.workspaceId === w.workspaceId) && (w.kind === undefined || d.kind === w.kind) && (w.version === undefined || d.version === w.version);
};
/** What Prisma's `select` does: only the named fields come back. */
const selectFrom = (row: DesignRow, select: Record<string, boolean>) => Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([k]) => [k, (row as unknown as Record<string, unknown>)[k]]));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    designAsset: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (h.createFails) throw new Error("db down");
        const row = { id: `asset-${h.rows.length + 1}`, ...data } as { id: string; workspaceId: string; storageRef: string };
        h.rows.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; workspaceId: string } }) => {
        // Like PostgreSQL (checked against the real dev database): a NUL in text is refused, and Prisma throws.
        if (where.id.includes("\u0000")) throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
        return h.rows.find((r) => r.id === where.id && r.workspaceId === where.workspaceId) ?? null;
      }),
      count: vi.fn(async ({ where }: { where: { id: { in: string[] }; workspaceId: string } }) =>
        h.rows.filter((r) => where.id.in.includes(r.id) && r.workspaceId === where.workspaceId).length,
      ),
    },
    design: {
      findMany: vi.fn(async ({ where, take, select }: { where: Where; take: number; select: Record<string, boolean> }) =>
        h.designs
          .filter((d) => matches(d, where))
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1))
          .slice(0, take)
          .map((d) => selectFrom(d, select)),
      ),
      create: vi.fn(async ({ data, select }: { data: Omit<DesignRow, "id" | "version" | "updatedAt">; select: Record<string, boolean> }) => {
        const row: DesignRow = { id: `design-${h.designs.length + 1}`, version: 1, updatedAt: new Date(2026, 0, 1, 0, 0, ++h.clock), ...data };
        h.designs.push(row);
        return selectFrom(row, select);
      }),
      findFirst: vi.fn(async ({ where, select }: { where: Where; select: Record<string, boolean> }) => {
        const row = h.designs.find((d) => matches(d, where));
        return row ? selectFrom(row, select) : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: { document: unknown; name?: string; version: { increment: number } } }) => {
        const row = h.designs.find((d) => matches(d, where));
        if (!row) return { count: 0 };
        row.document = data.document;
        if (data.name !== undefined) row.name = data.name;
        row.version += data.version.increment;
        row.updatedAt = new Date(2026, 0, 1, 0, 0, ++h.clock);
        return { count: 1 };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const keep = h.designs.filter((d) => !matches(d, where));
        const count = h.designs.length - keep.length;
        h.designs = keep;
        return { count };
      }),
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
  // Same answer as the real one: only the designer role may manage templates (and so designs).
  requireTemplateManagerRole: async () => (h.role === "designer" ? null : { error: "Templates are managed by the design team only.", code: "FORBIDDEN" }),
}));

import { canvasRoutes } from "./canvas.js";
import { prisma } from "../lib/prisma.js";
import { BLANK_DOCUMENT } from "../lib/canvas.js";
import { LocalDiskStorage } from "../lib/storage.js";

const db = prisma as unknown as { design: Record<"findMany" | "create" | "findFirst" | "updateMany" | "deleteMany", ReturnType<typeof vi.fn>>; designAsset: { count: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> } };

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
  h.role = "designer";
  h.rows = [];
  h.designs = [];
  h.clock = 0;
  h.createFails = false;
  for (const fn of Object.values(db.design)) fn.mockClear();
  db.designAsset.count.mockClear();
  db.designAsset.findFirst.mockClear();
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

  describe("an id that cannot be an id (a NUL in the path made PostgreSQL throw, so the API answered 500)", () => {
    const BAD = [
      ["a NUL in the middle", "a%00b"],
      ["only a NUL", "%00"],
      ["a NUL at the end", "a1%00"],
      ["a space", "a%201"],
      ["a dot", "a.1"],
      ["a dot-dot", "..%2F..%2Fx"],
      ["an encoded slash", "a%2F1"],
      ["a backslash", "a%5C1"],
      ["non-ASCII letters", "%E6%97%A5%E6%9C%AC"],
      ["65 characters", "x".repeat(65)],
      ["a percent sign", "a%251"],
      ["a trailing line break", "a1%0A"],
    ] as const;
    const get = (id: string) => app.inject({ method: "GET", url: `/canvas/assets/${id}/content` });

    it.each(BAD)("%s: the same 404 as an unknown id, with no database query and no storage read", async (_label, id) => {
      await seed(); // a real asset "a1" exists, so a loose lookup could have matched something
      const read = vi.spyOn(storage, "getBuffer");
      try {
        const res = await get(id);
        expect(res.statusCode, id).toBe(404);
        expect(res.json()).toEqual({ error: "Asset not found" });
        expect(db.designAsset.findFirst).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    });

    it("is word for word the answer for a well-formed id that simply does not exist (which is looked up)", async () => {
      const bad = await get("a%00b");
      const unknown = await get("clnotthere0000000000000000");
      expect(bad.statusCode).toBe(404);
      expect(bad.body).toBe(unknown.body);
      expect(db.designAsset.findFirst).toHaveBeenCalledTimes(1); // only the well-formed one
    });

    it("asks who is calling first: signed out is 401 whatever the id, and nothing is queried", async () => {
      h.authed = false;
      for (const [, id] of BAD) expect((await get(id)).statusCode, id).toBe(401);
      expect(db.designAsset.findFirst).not.toHaveBeenCalled();
    });

    it("does not change who may read an asset: any member of the workspace, Marketing included, still can", async () => {
      const bytes = await seed();
      for (const role of ["member", "designer", "admin", "owner", null]) {
        h.role = role; // the asset route has no role gate: a role is not needed, only membership of the workspace
        const ok = await get("a1");
        expect(ok.statusCode, String(role)).toBe(200);
        expect(ok.rawPayload.equals(bytes)).toBe(true);
        expect((await get("a%00b")).statusCode, String(role)).toBe(404);
      }
    });

    it("still refuses another workspace's asset and still serves your own, by the same real-looking ids", async () => {
      const bytes = await png();
      const ids = ["clxyz0abc0000abcdefghijkl", "550e8400-e29b-41d4-a716-446655440000", "a_b-C9", "x".repeat(64)];
      for (const id of ids) {
        h.rows = [];
        const mine = await storage.upload(bytes, "image/png", ".canvas-private/ws-1");
        const theirs = await storage.upload(bytes, "image/png", ".canvas-private/ws-2");
        h.rows.push({ id, workspaceId: "ws-1", storageRef: mine }, { id: `${id.slice(0, 20)}-other`, workspaceId: "ws-2", storageRef: theirs });
        const res = await get(id);
        expect(res.statusCode, id).toBe(200);
        expect(res.rawPayload.equals(bytes), id).toBe(true);
        expect(res.headers["cache-control"]).toBe("private, no-store");
        expect((await get(`${id.slice(0, 20)}-other`)).statusCode, id).toBe(404); // someone else's, by a well-formed id
      }
    });
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

  it("still answers 501 first for a malformed asset id, before the id is even looked at", async () => {
    const other = { upload: vi.fn(), getBuffer: vi.fn(), delete: vi.fn(), listFolder: vi.fn(), ownsUrl: vi.fn() };
    const closed = await build(other);
    h.authed = false;
    const res = await closed.inject({ method: "GET", url: "/canvas/assets/a%00b/content" });
    await closed.close();
    expect(res.statusCode).toBe(501);
    expect(db.designAsset.findFirst).not.toHaveBeenCalled();
    expect(other.getBuffer).not.toHaveBeenCalled();
  });

  it("still saves designs: only image bytes need local disk", async () => {
    const other = { upload: vi.fn(), getBuffer: vi.fn(), delete: vi.fn(), listFolder: vi.fn(), ownsUrl: vi.fn() };
    const closed = await build(other);
    const created = await closed.inject({ method: "POST", url: "/canvas/designs", payload: {} });
    const list = await closed.inject({ method: "GET", url: "/canvas/designs" });
    await closed.close();
    expect(created.statusCode).toBe(201);
    expect(list.statusCode).toBe(200);
    expect(other.upload).not.toHaveBeenCalled();
  });
});

// ── Designs ────────────────────────────────────────────────────────────────────────────────────────

const seedDesign = (over: Partial<DesignRow> = {}): DesignRow => {
  const row: DesignRow = {
    id: `d${h.designs.length + 1}`,
    workspaceId: "ws-1",
    kind: "template",
    name: "Spring sale",
    document: BLANK_DOCUMENT,
    version: 1,
    createdByUserId: "user-1",
    updatedAt: new Date(2026, 0, 1, 0, 0, ++h.clock),
    ...over,
  };
  h.designs.push(row);
  return row;
};
const imageDoc = (assetId: string) => ({
  ...BLANK_DOCUMENT,
  nodes: [
    {
      id: "i1", name: "Logo", parentId: null, x: 10, y: 10, width: 100, height: 100, rotation: 0, opacity: 1, visible: true,
      permission: "protected", type: "image", assetId, fit: "cover",
    },
  ],
});
const put = (id: string, payload: unknown) => app.inject({ method: "PUT", url: `/canvas/designs/${id}`, payload: payload as object });
const writes = () => db.design.create.mock.calls.length + db.design.updateMany.mock.calls.length + db.design.deleteMany.mock.calls.length;

describe("designs: who may use them", () => {
  const endpoints = [
    () => app.inject({ method: "GET", url: "/canvas/designs" }),
    () => app.inject({ method: "POST", url: "/canvas/designs", payload: {} }),
    () => app.inject({ method: "GET", url: "/canvas/designs/d1" }),
    () => put("d1", { version: 1, document: BLANK_DOCUMENT }),
    () => app.inject({ method: "DELETE", url: "/canvas/designs/d1" }),
  ];

  it("answers 401 on every endpoint when signed out, and touches nothing", async () => {
    seedDesign();
    h.authed = false;
    for (const call of endpoints) expect((await call()).statusCode).toBe(401);
    expect(h.designs).toHaveLength(1);
    expect(writes()).toBe(0);
    expect(db.design.findFirst).not.toHaveBeenCalled();
  });

  it.each(["member", "owner", "admin", "viewer", null])("answers 403 on every endpoint for the %s role, and touches nothing", async (role) => {
    seedDesign();
    h.role = role;
    for (const call of endpoints) {
      const res = await call();
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(h.designs).toHaveLength(1);
    expect(h.designs[0]).toMatchObject({ version: 1, name: "Spring sale" });
    expect(writes()).toBe(0);
    expect(db.design.findMany).not.toHaveBeenCalled();
    expect(db.design.findFirst).not.toHaveBeenCalled();
    expect(db.designAsset.count).not.toHaveBeenCalled();
  });
});

describe("POST /canvas/designs", () => {
  it("creates a blank design named 'Untitled design' in the caller's workspace, and answers with a summary only", async () => {
    const res = await app.inject({ method: "POST", url: "/canvas/designs", payload: {} }); // JSON with no name: what the editor sends
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json().design).sort()).toEqual(["id", "name", "updatedAt", "version"]);
    expect(res.json().design).toMatchObject({ name: "Untitled design", version: 1 });
    expect(h.designs[0]).toMatchObject({ workspaceId: "ws-1", kind: "template", createdByUserId: "user-1", document: BLANK_DOCUMENT });
    expect(res.body).not.toContain("document");
  });

  it("trims a given name", async () => {
    const res = await app.inject({ method: "POST", url: "/canvas/designs", payload: { name: "  Spring sale  " } });
    expect(res.statusCode).toBe(201);
    expect(h.designs[0].name).toBe("Spring sale");
  });

  it.each([["empty", ""], ["only spaces", "   "], ["101 characters", "x".repeat(101)], ["a line break inside", "a\nb"], ["a control character", "a\u0000b"], ["null", null], ["a number", 5]])(
    "refuses a name that is %s with INVALID_NAME, and creates nothing",
    async (_label, name) => {
      const res = await app.inject({ method: "POST", url: "/canvas/designs", payload: { name } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_NAME" });
      expect(h.designs).toHaveLength(0);
      expect(db.design.create).not.toHaveBeenCalled();
    },
  );

  it("never lets the client choose the kind, the workspace or the author", async () => {
    for (const extra of [{ kind: "instance" }, { workspaceId: "ws-2" }, { createdByUserId: "someone" }]) {
      const res = await app.inject({ method: "POST", url: "/canvas/designs", payload: { name: "A", ...extra } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(h.designs).toHaveLength(0);
  });

  describe("only a JSON object creates a design (a request that is not one must not quietly become a blank design)", () => {
    const post = (headers: Record<string, string>, payload?: string | Buffer) => app.inject({ method: "POST", url: "/canvas/designs", headers, payload });
    const refusedAndNothingCreated = () => {
      expect(h.designs).toHaveLength(0);
      expect(db.design.create).not.toHaveBeenCalled();
    };

    it("accepts a JSON body with no name, with or without a charset, and still names it 'Untitled design'", async () => {
      for (const type of ["application/json", "application/json; charset=utf-8", "Application/JSON"]) {
        const res = await post({ "content-type": type }, "{}");
        expect(res.statusCode, type).toBe(201);
        expect(res.json().design.name).toBe("Untitled design");
      }
      expect(h.designs).toHaveLength(3);
    });

    it("refuses a request with no body and no content type with 415", async () => {
      const res = await app.inject({ method: "POST", url: "/canvas/designs" });
      expect(res.statusCode).toBe(415);
      expect(res.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
      refusedAndNothingCreated();
    });

    it("refuses a multipart upload (what @fastify/multipart lets through untouched) with 415", async () => {
      const boundary = "----designs";
      const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nSpring sale\r\n--${boundary}--\r\n`);
      const res = await post({ "content-type": `multipart/form-data; boundary=${boundary}` }, body);
      expect(res.statusCode).toBe(415);
      expect(res.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
      refusedAndNothingCreated();
    });

    it.each([
      ["a plain-text body that looks like JSON", "text/plain", "{}"],
      ["a plain-text body with a name", "text/plain;charset=UTF-8", '{"name":"x"}'],
      ["a urlencoded form (what a cross-site <form> sends)", "application/x-www-form-urlencoded", "name=x"],
      ["a content type that only contains 'json'", "application/jsonp", "{}"],
      ["a JSON-looking suffix type", "application/vnd.api+json", "{}"],
      ["an empty content type", "", "{}"],
    ])("refuses %s with 415", async (_label, type, payload) => {
      const res = await post(type ? { "content-type": type } : {}, payload);
      expect(res.statusCode).toBe(415);
      refusedAndNothingCreated();
    });

    it.each([
      ["null", "null"],
      ["an array", "[]"],
      ["a string", '"x"'],
      ["a number", "5"],
    ])("refuses JSON that is %s with 400 and creates nothing (it is not defaulted to {})", async (_label, payload) => {
      const res = await post({ "content-type": "application/json" }, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_REQUEST" });
      refusedAndNothingCreated();
    });

    it("refuses an empty body and malformed JSON sent as JSON with 400, and creates nothing", async () => {
      expect((await post({ "content-type": "application/json" }, "")).statusCode).toBe(400);
      expect((await post({ "content-type": "application/json" }, "{")).statusCode).toBe(400);
      refusedAndNothingCreated();
    });

    it("checks who is asking before it looks at the content type: 401 signed out, 403 for anyone but a designer", async () => {
      h.authed = false;
      expect((await app.inject({ method: "POST", url: "/canvas/designs" })).statusCode).toBe(401);
      h.authed = true;
      h.role = "member";
      const res = await app.inject({ method: "POST", url: "/canvas/designs" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
      refusedAndNothingCreated();
    });
  });
});

describe("design ids that cannot be ids (a NUL in the path made PostgreSQL throw, so the API answered 500)", () => {
  const BAD = [
    ["a NUL in the middle", "a%00b"],
    ["only a NUL", "%00"],
    ["a NUL at the end", "abc%00"],
    ["a space", "a%20b"],
    ["a dot", "a.b"],
    ["an encoded slash", "a%2Fb"],
    ["a backslash", "a%5Cb"],
    ["non-ASCII letters", "%E6%97%A5%E6%9C%AC"],
    ["65 characters", "x".repeat(65)],
    ["a percent sign", "a%25b"],
  ] as const;
  const calls = (id: string) => [
    ["GET", () => app.inject({ method: "GET", url: `/canvas/designs/${id}` })],
    ["PUT", () => app.inject({ method: "PUT", url: `/canvas/designs/${id}`, payload: { version: 1, document: BLANK_DOCUMENT } })],
    ["DELETE", () => app.inject({ method: "DELETE", url: `/canvas/designs/${id}` })],
  ] as const;

  it.each(BAD)("%s: 404 on GET, PUT and DELETE, with no query made and nothing changed", async (_label, id) => {
    seedDesign({ id: "d1" });
    for (const [method, call] of calls(id)) {
      const res = await call();
      expect(res.statusCode, `${method} ${id}`).toBe(404);
      expect(res.json()).toEqual({ error: "Design not found" }); // the same answer as an unknown id
    }
    expect(db.design.findFirst).not.toHaveBeenCalled();
    expect(db.design.updateMany).not.toHaveBeenCalled();
    expect(db.design.deleteMany).not.toHaveBeenCalled();
    expect(db.designAsset.count).not.toHaveBeenCalled();
    expect(h.designs).toHaveLength(1);
    expect(h.designs[0]).toMatchObject({ id: "d1", version: 1 });
  });

  it("a PUT with a bad id and an image in the document does not even check the asset", async () => {
    const res = await app.inject({ method: "PUT", url: "/canvas/designs/a%00b", payload: { version: 1, document: { ...BLANK_DOCUMENT, nodes: [{ id: "i1", name: "L", parentId: null, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, visible: true, permission: "protected", type: "image", assetId: "asset-1", fit: "cover" }] } } });
    expect(res.statusCode).toBe(404);
    expect(db.designAsset.count).not.toHaveBeenCalled();
  });

  it("still tells a signed-out caller 401 and a non-designer 403 first, so an id's shape is not learned without being allowed", async () => {
    h.authed = false;
    for (const [, call] of calls("a%00b")) expect((await call()).statusCode).toBe(401);
    h.authed = true;
    h.role = "member";
    for (const [, call] of calls("a%00b")) expect((await call()).statusCode).toBe(403);
    expect(db.design.findFirst).not.toHaveBeenCalled();
  });

  it("every id a design can really have still works: cuid, uuid, dashes and underscores, 64 characters", async () => {
    for (const id of ["clxyz0abc0000abcdefghijkl", "550e8400-e29b-41d4-a716-446655440000", "a_b-C9", "x".repeat(64)]) {
      h.designs = [];
      seedDesign({ id });
      expect((await app.inject({ method: "GET", url: `/canvas/designs/${id}` })).statusCode, id).toBe(200);
      expect((await put(id, { version: 1, document: BLANK_DOCUMENT })).statusCode, id).toBe(200);
      expect((await app.inject({ method: "DELETE", url: `/canvas/designs/${id}` })).statusCode, id).toBe(200);
    }
  });

  it("a well-formed id that does not exist is still a plain 404 (it is looked up)", async () => {
    const res = await app.inject({ method: "GET", url: "/canvas/designs/clnotthere0000000000000000" });
    expect(res.statusCode).toBe(404);
    expect(db.design.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("GET /canvas/designs", () => {
  it("lists this workspace's designs, newest edit first, with no documents and no caching", async () => {
    seedDesign({ id: "old", name: "Old" });
    seedDesign({ id: "other-ws", workspaceId: "ws-2", name: "Not mine" });
    seedDesign({ id: "instance", kind: "instance", name: "An instance" });
    seedDesign({ id: "new", name: "New" });
    const res = await app.inject({ method: "GET", url: "/canvas/designs" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { designs } = res.json();
    expect(designs.map((d: { id: string }) => d.id)).toEqual(["new", "old"]);
    for (const d of designs) expect(Object.keys(d).sort()).toEqual(["id", "name", "updatedAt", "version"]);
    expect(res.body).not.toContain("document");
    expect(res.body).not.toContain("Not mine");
  });

  it("shows at most the newest 200", async () => {
    for (let i = 0; i < 205; i++) seedDesign({ id: `d${String(i).padStart(3, "0")}` });
    const { designs } = (await app.inject({ method: "GET", url: "/canvas/designs" })).json();
    expect(designs).toHaveLength(200);
    expect(designs[0].id).toBe("d204");
  });
});

describe("GET /canvas/designs/:id", () => {
  it("returns the design with its document, not cached", async () => {
    seedDesign({ id: "d1", document: imageDoc("asset-1") });
    const res = await app.inject({ method: "GET", url: "/canvas/designs/d1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json().design).toMatchObject({ id: "d1", name: "Spring sale", version: 1, document: imageDoc("asset-1") });
  });

  it("answers 404 for another workspace's design, an instance, and an unknown id", async () => {
    seedDesign({ id: "other-ws", workspaceId: "ws-2" });
    seedDesign({ id: "instance", kind: "instance" });
    for (const id of ["other-ws", "instance", "nope"]) {
      const res = await app.inject({ method: "GET", url: `/canvas/designs/${id}` });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("ws-2");
    }
  });
});

describe("PUT /canvas/designs/:id", () => {
  const edited = { ...BLANK_DOCUMENT, background: { color: "#112233" } };

  it("saves the document, bumps the version in one conditional update, and answers with the new version", async () => {
    seedDesign({ id: "d1" });
    const res = await put("d1", { version: 1, document: edited });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: 2 });
    expect(h.designs[0]).toMatchObject({ version: 2, document: edited, name: "Spring sale" });
    // The write names the version it was based on (the optimistic lock) and the caller's own workspace and kind.
    expect(db.design.updateMany).toHaveBeenCalledTimes(1);
    expect(db.design.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "d1", workspaceId: "ws-1", kind: "template", version: 1 },
      data: { version: { increment: 1 } },
    });
    // No read-back: a second read could return somebody else's later save, which the editor would take for its own.
    expect(db.design.findFirst).not.toHaveBeenCalled();
  });

  it("saves in sequence: versions 1 to 2 to 3", async () => {
    seedDesign({ id: "d1" });
    expect((await put("d1", { version: 1, document: edited })).json()).toEqual({ version: 2 });
    expect((await put("d1", { version: 2, document: BLANK_DOCUMENT })).json()).toEqual({ version: 3 });
    expect(h.designs[0]).toMatchObject({ version: 3, document: BLANK_DOCUMENT });
  });

  it("answers 409 VERSION_CONFLICT for a stale version, and writes nothing", async () => {
    seedDesign({ id: "d1", version: 5, document: BLANK_DOCUMENT });
    const res = await put("d1", { version: 4, document: edited });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(res.body).not.toContain("document"); // nothing of the stored design leaks into the refusal
    expect(h.designs[0]).toMatchObject({ version: 5, document: BLANK_DOCUMENT });
    const ahead = await put("d1", { version: 6, document: edited }); // a version from the future is no better
    expect(ahead.statusCode).toBe(409);
    expect(h.designs[0].version).toBe(5);
  });

  it("two saves from the same version: the first wins, the second is refused", async () => {
    seedDesign({ id: "d1" });
    expect((await put("d1", { version: 1, document: edited })).statusCode).toBe(200);
    const second = await put("d1", { version: 1, document: { ...BLANK_DOCUMENT, background: { color: "#999999" } } });
    expect(second.statusCode).toBe(409);
    expect(h.designs[0].document).toEqual(edited);
  });

  it("renames with a trimmed name, saves a name-only change, and keeps the name when none is sent", async () => {
    seedDesign({ id: "d1" });
    await put("d1", { version: 1, document: BLANK_DOCUMENT, name: "  Summer  " }); // same document, new name
    expect(h.designs[0]).toMatchObject({ name: "Summer", version: 2 });
    await put("d1", { version: 2, document: edited }); // no name
    expect(h.designs[0]).toMatchObject({ name: "Summer", version: 3 });
    expect(db.design.updateMany.mock.calls[1][0].data).not.toHaveProperty("name");
  });

  it.each([["empty", ""], ["only spaces", "   "], ["101 characters", "x".repeat(101)], ["a line break inside", "a\nb"], ["null", null], ["a number", 5]])(
    "refuses a name that is %s with INVALID_NAME, and writes nothing",
    async (_label, name) => {
      seedDesign({ id: "d1" });
      const res = await put("d1", { version: 1, document: edited, name });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_NAME" });
      expect(h.designs[0]).toMatchObject({ version: 1, name: "Spring sale", document: BLANK_DOCUMENT });
      expect(db.design.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["an unknown key on a layer", { ...BLANK_DOCUMENT, nodes: [{ ...imageDoc("asset-1").nodes[0], url: "https://evil.example/x.png" }] }],
    ["an unknown key on the document", { ...BLANK_DOCUMENT, href: "https://evil.example" }],
    ["a number past its limit", { ...BLANK_DOCUMENT, nodes: [{ ...imageDoc("asset-1").nodes[0], width: 20_001 }] }],
    ["an asset id that is a URL", imageDoc("https://evil.example/x.png")],
    ["an asset id with a path", imageDoc("../../user/me")],
    ["another schema version", { ...BLANK_DOCUMENT, schemaVersion: 2 }],
    ["text with a NUL", { ...BLANK_DOCUMENT, nodes: [{ ...imageDoc("a").nodes[0], type: "text", text: "a\u0000b", fontFamily: "Inter", fontSize: 20, fontStyle: "400", align: "left", lineHeight: 1.2, letterSpacing: 0, assetId: undefined, fit: undefined }] }],
  ])("refuses %s with INVALID_DOCUMENT, and writes nothing", async (_label, document) => {
    seedDesign({ id: "d1" });
    h.rows.push({ id: "asset-1", workspaceId: "ws-1", storageRef: "x" });
    const res = await put("d1", { version: 1, document });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_DOCUMENT" });
    expect(res.json().error).toMatch(/^document/); // names where the problem is
    expect(h.designs[0]).toMatchObject({ version: 1, document: BLANK_DOCUMENT });
    expect(db.design.updateMany).not.toHaveBeenCalled();
  });

  it("never lets the client choose the kind or the workspace, and needs a whole version", async () => {
    seedDesign({ id: "d1" });
    for (const body of [{ version: 1, document: edited, kind: "instance" }, { version: 1, document: edited, workspaceId: "ws-2" }, { document: edited }, { version: "1", document: edited }, { version: 0, document: edited }, undefined]) {
      const res = await put("d1", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(writes()).toBe(0);
  });

  it("checks on every save that each image is an asset of this workspace", async () => {
    seedDesign({ id: "d1" });
    h.rows.push({ id: "asset-mine", workspaceId: "ws-1", storageRef: "x" }, { id: "asset-theirs", workspaceId: "ws-2", storageRef: "y" });

    const theirs = await put("d1", { version: 1, document: imageDoc("asset-theirs") });
    expect(theirs.statusCode).toBe(400);
    expect(theirs.json()).toMatchObject({ code: "UNKNOWN_ASSET" });
    expect(theirs.body).not.toContain("asset-theirs");
    const invented = await put("d1", { version: 1, document: imageDoc("asset-made-up") });
    expect(invented.statusCode).toBe(400);
    expect(invented.json()).toMatchObject({ code: "UNKNOWN_ASSET" });
    expect(h.designs[0].version).toBe(1);

    const mine = await put("d1", { version: 1, document: imageDoc("asset-mine") });
    expect(mine.statusCode).toBe(200);
    expect(db.designAsset.count).toHaveBeenLastCalledWith({ where: { id: { in: ["asset-mine"] }, workspaceId: "ws-1" } });
    // and again on the next save, not only the first
    db.designAsset.count.mockClear();
    expect((await put("d1", { version: 2, document: imageDoc("asset-mine") })).statusCode).toBe(200);
    expect(db.designAsset.count).toHaveBeenCalledTimes(1);
  });

  it("asks about each asset once, and not at all for a design with no image", async () => {
    seedDesign({ id: "d1" });
    await put("d1", { version: 1, document: BLANK_DOCUMENT });
    expect(db.designAsset.count).not.toHaveBeenCalled();
  });

  it("answers 404 for another workspace's design, an instance and an unknown id, and writes nothing", async () => {
    seedDesign({ id: "other-ws", workspaceId: "ws-2" });
    seedDesign({ id: "instance", kind: "instance" });
    for (const id of ["other-ws", "instance", "nope"]) expect((await put(id, { version: 1, document: edited })).statusCode).toBe(404);
    expect(h.designs.map((d) => d.version)).toEqual([1, 1]);
    expect(h.designs[0].document).toEqual(BLANK_DOCUMENT);
  });

  it("refuses a body over 1 MB with 413, and writes nothing", async () => {
    seedDesign({ id: "d1" });
    const res = await put("d1", { version: 1, document: { ...BLANK_DOCUMENT, source: { kind: "x".repeat(1_100_000) } } });
    expect(res.statusCode).toBe(413);
    expect(db.design.updateMany).not.toHaveBeenCalled();
  });
});

describe("DELETE /canvas/designs/:id", () => {
  it("deletes the caller's design", async () => {
    seedDesign({ id: "d1" });
    const res = await app.inject({ method: "DELETE", url: "/canvas/designs/d1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(h.designs).toHaveLength(0);
    expect(db.design.deleteMany.mock.calls[0][0]).toEqual({ where: { id: "d1", workspaceId: "ws-1", kind: "template" } });
  });

  it("answers 404 and deletes nothing for another workspace's design, an instance and an unknown id", async () => {
    seedDesign({ id: "other-ws", workspaceId: "ws-2" });
    seedDesign({ id: "instance", kind: "instance" });
    for (const id of ["other-ws", "instance", "nope"]) expect((await app.inject({ method: "DELETE", url: `/canvas/designs/${id}` })).statusCode).toBe(404);
    expect(h.designs).toHaveLength(2);
  });
});
