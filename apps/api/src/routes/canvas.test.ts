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

interface TemplateRow {
  id: string;
  workspaceId: string;
  category: string;
  linkUrl: string | null;
  published: boolean;
  designId: string | null;
}
interface RevisionRow {
  id: string;
  designId: string;
  number: number;
  designVersion: number;
  document: unknown;
  manifest: unknown;
  createdByUserId: string | null;
  createdAt: Date;
}

const h = vi.hoisted(() => ({
  authed: true,
  workspace: "ws-1" as string | null,
  role: "designer" as string | null,
  rows: [] as Array<{ id: string; workspaceId: string; storageRef: string }>,
  designs: [] as DesignRow[],
  templates: [] as TemplateRow[],
  revisions: [] as RevisionRow[],
  clock: 0,
  createFails: false,
  // What ran, in order. "tx:" and "out:" say whether a read happened inside a $transaction; "lock:" is a FOR UPDATE.
  log: [] as string[],
  inTx: false,
  // Makes the next write to the template's designId fail the way the unique index does (Prisma error P2002).
  attachRaces: false,
  // While a transaction runs: true only inside a call made through the transaction's own client, and the designs a call
  // made through the plain client (outside the transaction) created, which a rollback must NOT undo, like in PostgreSQL.
  viaTx: false,
  outsideDesigns: [] as DesignRow[],
}));

type Where = { id?: string; workspaceId?: string; kind?: string; version?: number };
const nul = (v: unknown) => typeof v === "string" && v.includes("\u0000");
// PostgreSQL refuses a NUL in text (error 22021) and Prisma throws it: a test double that quietly matched nothing
// would hide a 500 that the real database causes. Checked against the real dev database.
const refuseNul = (...values: unknown[]) => {
  if (values.some(nul)) throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
};
const matches = (d: DesignRow, w: Where) => {
  refuseNul(w.id);
  return (w.id === undefined || d.id === w.id) && (w.workspaceId === undefined || d.workspaceId === w.workspaceId) && (w.kind === undefined || d.kind === w.kind) && (w.version === undefined || d.version === w.version);
};

type Spec = true | { select?: Record<string, unknown>; take?: number; orderBy?: unknown };
const pick = (row: object, select: Record<string, unknown>) => Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([k]) => [k, (row as Record<string, unknown>)[k]]));
/** Revisions of a design, as a nested `revisions: { orderBy: number desc, take, select }` asks for them. */
const revisionsOf = (designId: string, spec: Spec) =>
  h.revisions
    .filter((r) => r.designId === designId)
    .sort((a, b) => b.number - a.number)
    .slice(0, typeof spec === "object" && spec.take ? spec.take : undefined)
    .map((r) => pick(r, (typeof spec === "object" && spec.select) || { number: true }));
/** What Prisma's `select` does: only the named fields come back; a relation is resolved from the other stores. */
const selectFrom = (row: DesignRow, select: Record<string, Spec>) =>
  Object.fromEntries(
    Object.entries(select)
      .filter(([, spec]) => spec)
      .map(([k, spec]) => {
        if (k === "template") {
          const t = h.templates.find((x) => x.designId === row.id);
          return [k, t ? pick(t, (spec as { select: Record<string, unknown> }).select) : null];
        }
        if (k === "revisions") return [k, revisionsOf(row.id, spec)];
        return [k, (row as unknown as Record<string, unknown>)[k]];
      }),
  );
const selectTemplate = (t: TemplateRow, select: Record<string, Spec>) =>
  Object.fromEntries(
    Object.entries(select)
      .filter(([, spec]) => spec)
      .map(([k, spec]) => (k === "design" ? [k, t.designId ? { revisions: revisionsOf(t.designId, (spec as { select: { revisions: Spec } }).select.revisions) } : null] : [k, (t as unknown as Record<string, unknown>)[k]])),
  );
const trace = (op: string) => h.log.push(`${h.inTx ? "tx" : "out"}:${op}`);

// The store lives in `h` and the helpers above are only called when a query runs, never while this factory runs.
vi.mock("../lib/prisma.js", () => {
  const client = {
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
      count: vi.fn(async ({ where }: { where: { id: { in: string[] }; workspaceId: string } }) => {
        trace("designAsset.count");
        return h.rows.filter((r) => where.id.in.includes(r.id) && r.workspaceId === where.workspaceId).length;
      }),
    },
    design: {
      findMany: vi.fn(async ({ where, take, select }: { where: Where; take: number; select: Record<string, Spec> }) =>
        h.designs
          .filter((d) => matches(d, where))
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1))
          .slice(0, take)
          .map((d) => selectFrom(d, select)),
      ),
      create: vi.fn(async ({ data, select }: { data: Omit<DesignRow, "id" | "version" | "updatedAt">; select: Record<string, Spec> }) => {
        h.log.push(h.inTx && !h.viaTx ? "write:design:OUTSIDE" : "write:design");
        const row: DesignRow = { id: `design-${h.designs.length + 1}`, version: 1, updatedAt: new Date(2026, 0, 1, 0, 0, ++h.clock), ...data };
        h.designs.push(row);
        if (h.inTx && !h.viaTx) h.outsideDesigns.push(row); // committed on its own: the transaction's rollback cannot take it back
        return selectFrom(row, select);
      }),
      findFirst: vi.fn(async ({ where, select }: { where: Where; select: Record<string, Spec> }) => {
        trace("design.findFirst");
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
    template: {
      // `designId: undefined` means no condition; `null` means "has no design", like Prisma.
      findFirst: vi.fn(async ({ where, select }: { where: { id?: string; workspaceId?: string; designId?: string | null }; select: Record<string, Spec> }) => {
        refuseNul(where.id, where.designId);
        trace("template.findFirst");
        const t = h.templates.find((x) => (where.id === undefined || x.id === where.id) && (where.workspaceId === undefined || x.workspaceId === where.workspaceId) && (where.designId === undefined || (x.designId ?? null) === where.designId));
        return t ? selectTemplate(t, select) : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; workspaceId: string; designId?: null }; data: { designId?: string | null; published?: boolean } }) => {
        h.log.push("write:template");
        if (h.attachRaces && typeof data.designId === "string") throw Object.assign(new Error("Unique constraint failed on the fields: (`designId`)"), { code: "P2002" });
        const t = h.templates.find((x) => x.id === where.id && x.workspaceId === where.workspaceId && (where.designId === undefined || x.designId === null));
        if (!t) return { count: 0 };
        if ("designId" in data) t.designId = data.designId ?? null;
        if (data.published !== undefined) t.published = data.published;
        return { count: 1 };
      }),
    },
    designRevision: {
      findFirst: vi.fn(async ({ where, orderBy, select }: { where: { designId: string; designVersion?: number }; orderBy?: { number: "desc" }; select: Record<string, boolean> }) => {
        trace("designRevision.findFirst");
        const rows = h.revisions.filter((r) => r.designId === where.designId && (where.designVersion === undefined || r.designVersion === where.designVersion));
        if (orderBy) rows.sort((a, b) => b.number - a.number);
        return rows[0] ? pick(rows[0], select) : null;
      }),
      create: vi.fn(async ({ data, select }: { data: Omit<RevisionRow, "id" | "createdAt">; select: Record<string, boolean> }) => {
        h.log.push("write:revision");
        // The two unique keys of the table: (designId, number) and (designId, designVersion).
        if (h.revisions.some((r) => r.designId === data.designId && (r.number === data.number || r.designVersion === data.designVersion))) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        const row: RevisionRow = { id: `rev-${h.revisions.length + 1}`, createdAt: new Date(2026, 0, 2, 0, 0, ++h.clock), ...data };
        h.revisions.push(row);
        return pick(row, select);
      }),
    },
    // SELECT ... FOR UPDATE: the row's id when it exists in this workspace (and, for a design, is a template), else nothing.
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      refuseNul(...values);
      const sql = strings.join("?");
      if (sql.includes('FROM "Template"')) {
        h.log.push("lock:template");
        const [id, workspaceId] = values;
        return h.templates.some((t) => t.id === id && t.workspaceId === workspaceId) ? [{ id }] : [];
      }
      if (sql.includes('FROM "Design"')) {
        h.log.push("lock:design");
        const [id, workspaceId, kind] = values;
        return h.designs.some((d) => d.id === id && d.workspaceId === workspaceId && d.kind === kind) ? [{ id }] : [];
      }
      throw new Error(`unexpected raw query: ${sql}`);
    }),
  };
  return {
    prisma: {
      ...client,
      // A transaction runs its callback with its OWN client over the same store. If the callback throws, everything written
      // through that client is put back (a ROLLBACK); a write made through the plain client meanwhile is not (it committed).
      $transaction: vi.fn(async (run: (tx: typeof client) => Promise<unknown>) => {
        h.log.push("tx:begin");
        h.inTx = true;
        h.outsideDesigns = [];
        const saved = { designs: h.designs.map((d) => ({ ...d })), templates: h.templates.map((t) => ({ ...t })), revisions: h.revisions.slice() };
        const through = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
          h.viaTx = true;
          try {
            return await fn(...a);
          } finally {
            h.viaTx = false;
          }
        };
        const tx = {
          ...client,
          design: { ...client.design, create: through(client.design.create) },
          template: { ...client.template, updateMany: through(client.template.updateMany), findFirst: through(client.template.findFirst) },
        } as typeof client;
        try {
          return await run(tx);
        } catch (err) {
          h.designs = [...saved.designs, ...h.outsideDesigns];
          h.templates = saved.templates;
          h.revisions = saved.revisions;
          h.log.push("tx:rollback");
          throw err;
        } finally {
          h.inTx = false;
          h.log.push("tx:end");
        }
      }),
    },
  };
});
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

type Fn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as {
  design: Record<"findMany" | "create" | "findFirst" | "updateMany" | "deleteMany", Fn>;
  designAsset: { count: Fn; findFirst: Fn };
  template: Record<"findFirst" | "updateMany", Fn>;
  designRevision: Record<"findFirst" | "create", Fn>;
  $transaction: Fn;
  $queryRaw: Fn;
};

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
  h.templates = [];
  h.revisions = [];
  h.log = [];
  h.inTx = false;
  h.attachRaces = false;
  h.viaTx = false;
  h.outsideDesigns = [];
  h.clock = 0;
  h.createFails = false;
  for (const fn of [...Object.values(db.design), ...Object.values(db.template), ...Object.values(db.designRevision), db.$transaction, db.$queryRaw]) fn.mockClear();
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
const seedTemplate = (over: Partial<TemplateRow> = {}): TemplateRow => {
  const row: TemplateRow = { id: `t${h.templates.length + 1}`, workspaceId: "ws-1", category: "Case Study", linkUrl: null, published: false, designId: null, ...over };
  h.templates.push(row);
  return row;
};
const seedRevision = (designId: string, number: number, over: Partial<RevisionRow> = {}): RevisionRow => {
  const row: RevisionRow = { id: `r-${designId}-${number}`, designId, number, designVersion: number, document: BLANK_DOCUMENT, manifest: { schemaVersion: 1, fields: [] }, createdByUserId: "user-1", createdAt: new Date(2026, 0, 2, 0, 0, number), ...over };
  h.revisions.push(row);
  return row;
};
const FIGMA = "https://www.figma.com/design/AbC123/Case-study";
/** A text layer of a design, valid for the server's schema. */
const textLayer = (id: string, change: Record<string, unknown> = {}) => ({
  id, name: `Layer ${id}`, parentId: null, x: 0, y: 0, width: 200, height: 40, rotation: 0, opacity: 1, visible: true, permission: "protected",
  type: "text", text: "Hello", fontFamily: "Inter", fontSize: 24, fontStyle: "400", align: "left", lineHeight: 1.2, letterSpacing: 0, ...change,
});
const groupLayer = (id: string, change: Record<string, unknown> = {}) => ({
  id, name: `Layer ${id}`, parentId: null, x: 0, y: 0, width: 50, height: 50, rotation: 0, opacity: 1, visible: true, permission: "protected", type: "group", ...change,
});
const docOf = (...nodes: unknown[]) => ({ ...BLANK_DOCUMENT, nodes });
const put = (id: string, payload: unknown) => app.inject({ method: "PUT", url: `/canvas/designs/${id}`, payload: payload as object });
const publish = (id: string, payload: unknown = { version: 1 }) => app.inject({ method: "POST", url: `/canvas/designs/${id}/publish`, payload: payload as object });
const attach = (templateId: string, designId: string) => app.inject({ method: "PUT", url: `/canvas/templates/${templateId}/design`, payload: { designId } });
const detach = (templateId: string) => app.inject({ method: "DELETE", url: `/canvas/templates/${templateId}/design` });
/** What the log says about the order of two operations. */
const before = (a: string, b: string) => h.log.indexOf(a) !== -1 && h.log.indexOf(a) < h.log.indexOf(b);
const writes = () => db.design.create.mock.calls.length + db.design.updateMany.mock.calls.length + db.design.deleteMany.mock.calls.length;

describe("designs: who may use them", () => {
  const endpoints = [
    () => app.inject({ method: "GET", url: "/canvas/designs" }),
    () => app.inject({ method: "POST", url: "/canvas/designs", payload: {} }),
    () => app.inject({ method: "GET", url: "/canvas/designs/d1" }),
    () => put("d1", { version: 1, document: BLANK_DOCUMENT }),
    () => app.inject({ method: "DELETE", url: "/canvas/designs/d1" }),
    () => app.inject({ method: "POST", url: "/canvas/designs/d1/publish", payload: { version: 1 } }),
    () => app.inject({ method: "PUT", url: "/canvas/templates/t1/design", payload: { designId: "d1" } }),
    () => app.inject({ method: "POST", url: "/canvas/templates/t1/design", payload: {} }),
    () => app.inject({ method: "DELETE", url: "/canvas/templates/t1/design" }),
  ];
  const touchedNothing = () => {
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.template.findFirst).not.toHaveBeenCalled();
    expect(db.template.updateMany).not.toHaveBeenCalled();
    expect(db.designRevision.findFirst).not.toHaveBeenCalled();
    expect(db.designRevision.create).not.toHaveBeenCalled();
    expect(h.revisions).toHaveLength(0);
  };

  it("answers 401 on every endpoint when signed out, and touches nothing", async () => {
    seedDesign();
    h.authed = false;
    for (const call of endpoints) expect((await call()).statusCode).toBe(401);
    expect(h.designs).toHaveLength(1);
    expect(writes()).toBe(0);
    expect(db.design.findFirst).not.toHaveBeenCalled();
    touchedNothing();
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
    touchedNothing();
  });
});

describe("POST /canvas/designs", () => {
  it("creates a blank design named 'Untitled design' in the caller's workspace, and answers with a summary only", async () => {
    const res = await app.inject({ method: "POST", url: "/canvas/designs", payload: {} }); // JSON with no name: what the editor sends
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json().design).sort()).toEqual(["id", "latestRevision", "name", "template", "updatedAt", "version"]);
    expect(res.json().design).toMatchObject({ name: "Untitled design", version: 1, template: null, latestRevision: null });
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
    for (const d of designs) expect(Object.keys(d).sort()).toEqual(["id", "latestRevision", "name", "template", "updatedAt", "version"]);
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

// ── Phase 4: the design list, linked designs, revisions and the template link ───────────────────────────────────

describe("the design list and a single design carry their template and latest revision", () => {
  it("a design with no template and no revision says so, in the list and in GET one", async () => {
    seedDesign({ id: "d1" });
    const list = (await app.inject({ method: "GET", url: "/canvas/designs" })).json().designs[0];
    expect(list).toMatchObject({ id: "d1", template: null, latestRevision: null });
    const one = (await app.inject({ method: "GET", url: "/canvas/designs/d1" })).json().design;
    expect(one).toMatchObject({ template: null, latestRevision: null, document: BLANK_DOCUMENT });
  });

  it("shows the template it is attached to and the newest of its revisions, and nothing else of either", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1", designId: "d1", published: true, linkUrl: FIGMA });
    seedRevision("d1", 1);
    seedRevision("d1", 2);
    const { designs } = (await app.inject({ method: "GET", url: "/canvas/designs" })).json();
    expect(designs[0].template).toEqual({ id: "t1", category: "Case Study", published: true });
    expect(Object.keys(designs[0].latestRevision).sort()).toEqual(["createdAt", "designVersion", "number"]);
    expect(designs[0].latestRevision.number).toBe(2);
    expect(JSON.stringify(designs)).not.toContain("manifest");
    expect(JSON.stringify(designs)).not.toContain("linkUrl");
    expect(JSON.stringify(designs)).not.toContain("workspaceId");
  });
});

describe("DELETE /canvas/designs/:id: a design a template is made from cannot be deleted", () => {
  it("answers 409 DESIGN_LINKED, deletes nothing, and keeps the revisions", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1", designId: "d1" });
    seedRevision("d1", 1);
    const res = await app.inject({ method: "DELETE", url: "/canvas/designs/d1" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "DESIGN_LINKED" });
    expect(db.design.deleteMany).not.toHaveBeenCalled();
    expect(h.designs).toHaveLength(1);
    expect(h.revisions).toHaveLength(1);
  });

  it("the foreign key is the backstop: a link made after the check (P2003) is the same 409, not a 500", async () => {
    seedDesign({ id: "d1" });
    db.design.deleteMany.mockRejectedValueOnce(Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" }));
    const res = await app.inject({ method: "DELETE", url: "/canvas/designs/d1" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "DESIGN_LINKED" });
  });

  it("any other database error is still an error", async () => {
    seedDesign({ id: "d1" });
    db.design.deleteMany.mockRejectedValueOnce(new Error("db down"));
    expect((await app.inject({ method: "DELETE", url: "/canvas/designs/d1" })).statusCode).toBe(500);
  });

  it("an unlinked design is deleted, with the check scoped to this workspace", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "elsewhere", workspaceId: "ws-2", designId: "d1" }); // another workspace's row never blocks this one
    expect((await app.inject({ method: "DELETE", url: "/canvas/designs/d1" })).statusCode).toBe(200);
    expect(db.template.findFirst.mock.calls[0][0].where).toEqual({ designId: "d1", workspaceId: "ws-1" });
  });
});

describe("POST /canvas/designs/:id/publish", () => {
  const editable = () => docOf(textLayer("t", { permission: "text" }), textLayer("p"));

  it("freezes the STORED document, derives the manifest itself, numbers the revision and records who published it", async () => {
    seedDesign({ id: "d1", version: 3, document: editable() });
    const res = await publish("d1", { version: 3 });
    expect(res.statusCode).toBe(201);
    expect(res.json().revision).toMatchObject({ number: 1, designVersion: 3 });
    expect(Object.keys(res.json().revision).sort()).toEqual(["createdAt", "designVersion", "number"]);
    expect(h.revisions).toHaveLength(1);
    expect(h.revisions[0]).toMatchObject({ designId: "d1", number: 1, designVersion: 3, createdByUserId: "user-1", document: editable(), manifest: { schemaVersion: 1, fields: [{ nodeId: "t", kind: "text" }] } });
    // The design itself is not touched: publishing only adds a row.
    expect(h.designs[0].version).toBe(3);
    expect(db.design.updateMany).not.toHaveBeenCalled();
  });

  it("the next revision is numbered after the last one, and each working version is published once", async () => {
    seedDesign({ id: "d1", version: 1, document: editable() });
    expect((await publish("d1", { version: 1 })).statusCode).toBe(201);
    expect((await publish("d1", { version: 1 })).json()).toMatchObject({ code: "NO_CHANGES" }); // same version again
    h.designs[0].version = 2;
    const second = await publish("d1", { version: 2 });
    expect(second.json().revision).toMatchObject({ number: 2, designVersion: 2 });
    expect(h.revisions.map((r) => r.number)).toEqual([1, 2]);
    expect(h.revisions[0]).toMatchObject({ designVersion: 1 }); // the first one is exactly as it was
  });

  it("never overwrites a revision: the only write is an insert, and nothing updates or deletes one", async () => {
    seedDesign({ id: "d1", version: 1, document: editable() });
    seedRevision("d1", 1, { designVersion: 7 });
    const first = structuredClone(h.revisions[0]);
    await publish("d1", { version: 1 });
    expect(h.revisions[0]).toEqual(first);
    expect(Object.keys(db.designRevision).sort()).toEqual(["create", "findFirst"]); // no update, delete or upsert exists for the route to call
  });

  it("answers 409 VERSION_CONFLICT for a version that is not the stored one, and writes nothing", async () => {
    seedDesign({ id: "d1", version: 4, document: editable() });
    const res = await publish("d1", { version: 3 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(h.revisions).toHaveLength(0);
  });

  it("locks the design's row first, and reads and writes only inside the transaction", async () => {
    seedDesign({ id: "d1", version: 1, document: editable() });
    await publish("d1", { version: 1 });
    expect(h.log[0]).toBe("tx:begin");
    expect(h.log[1]).toBe("lock:design");
    expect(h.log.filter((x) => x.startsWith("out:"))).toEqual([]);
    expect(before("lock:design", "tx:design.findFirst")).toBe(true);
    expect(before("tx:design.findFirst", "write:revision")).toBe(true);
    expect(h.log.at(-1)).toBe("tx:end");
  });

  it("refuses an editable layer that is hidden, and names it; nothing is written", async () => {
    seedDesign({ id: "d1", version: 1, document: docOf(textLayer("t", { permission: "text", visible: false, name: "Headline" })) });
    const res = await publish("d1", { version: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_PUBLISH" });
    expect(res.json().error).toContain('"Headline" is editable but hidden');
    expect(h.revisions).toHaveLength(0);
  });

  it("refuses an editable layer inside a hidden group, and names the layer and the group", async () => {
    seedDesign({ id: "d1", version: 1, document: docOf(groupLayer("g", { visible: false, name: "Hero" }), textLayer("t", { permission: "text", parentId: "g", name: "Title" })) });
    const res = await publish("d1", { version: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('"Title" is editable but hidden because its group "Hero" is hidden');
    expect(h.revisions).toHaveLength(0);
  });

  it("a hidden layer that is protected does not block a publish", async () => {
    seedDesign({ id: "d1", version: 1, document: docOf(textLayer("p", { visible: false }), textLayer("t", { permission: "text" })) });
    expect((await publish("d1", { version: 1 })).statusCode).toBe(201);
    expect(h.revisions[0].manifest).toEqual({ schemaVersion: 1, fields: [{ nodeId: "t", kind: "text" }] });
  });

  it("a design with nothing editable can still be published (the manifest is empty)", async () => {
    seedDesign({ id: "d1", version: 1 });
    expect((await publish("d1", { version: 1 })).statusCode).toBe(201);
    expect(h.revisions[0].manifest).toEqual({ schemaVersion: 1, fields: [] });
  });

  it("checks the images again: an asset of another workspace or a made-up one is UNKNOWN_ASSET, nothing is written", async () => {
    h.rows = [{ id: "mine", workspaceId: "ws-1", storageRef: "x" }, { id: "theirs", workspaceId: "ws-2", storageRef: "y" }];
    for (const assetId of ["theirs", "made-up"]) {
      h.designs = [];
      seedDesign({ id: "d1", version: 1, document: imageDoc(assetId) });
      const res = await publish("d1", { version: 1 });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "UNKNOWN_ASSET" });
    }
    expect(h.revisions).toHaveLength(0);
    h.designs = [];
    seedDesign({ id: "d1", version: 1, document: imageDoc("mine") });
    expect((await publish("d1", { version: 1 })).statusCode).toBe(201);
  });

  it("validates the stored document again, so a bad stored row is not frozen", async () => {
    seedDesign({ id: "d1", version: 1, document: { schemaVersion: 2, nodes: [] } });
    const res = await publish("d1", { version: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_DOCUMENT" });
    expect(h.revisions).toHaveLength(0);
  });

  it.each([
    ["a document", { version: 1, document: BLANK_DOCUMENT }],
    ["a manifest", { version: 1, manifest: { schemaVersion: 1, fields: [{ nodeId: "p", kind: "text" }] } }],
    ["a number", { version: 1, number: 99 }],
    ["a design id", { version: 1, designId: "d2" }],
    ["an author", { version: 1, createdByUserId: "someone" }],
    ["a workspace", { version: 1, workspaceId: "ws-2" }],
    ["a kind", { version: 1, kind: "instance" }],
    ["no version", {}],
    ["a zero version", { version: 0 }],
    ["a text version", { version: "1" }],
  ])("refuses a body with %s (a client chooses nothing but the version), and writes nothing", async (_label, payload) => {
    seedDesign({ id: "d1", version: 1, document: editable() });
    const res = await publish("d1", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(h.revisions).toHaveLength(0);
  });

  it("answers 415 for a body that is not JSON", async () => {
    seedDesign({ id: "d1", version: 1, document: editable() });
    const res = await app.inject({ method: "POST", url: "/canvas/designs/d1/publish", headers: { "content-type": "text/plain" }, payload: '{"version":1}' });
    expect(res.statusCode).toBe(415);
    expect(h.revisions).toHaveLength(0);
  });

  it("answers 404 for another workspace's design, an instance, an unknown id and a bad id; nothing is written", async () => {
    seedDesign({ id: "other-ws", workspaceId: "ws-2", document: editable() });
    seedDesign({ id: "instance", kind: "instance", document: editable() });
    for (const id of ["other-ws", "instance", "nope", "a%00b", "a%20b"]) expect((await publish(id)).statusCode, id).toBe(404);
    expect(h.revisions).toHaveLength(0);
  });

  it("a race past the check ends in the table's unique keys: P2002 is a 409, never a 500", async () => {
    seedDesign({ id: "d1", version: 1, document: editable() });
    db.designRevision.create.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const res = await publish("d1", { version: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NO_CHANGES" });
  });
});

describe("PUT /canvas/templates/:id/design (attach)", () => {
  it("links a design to a draft that has no source yet (a draft is prepared before it is published)", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1" });
    const res = await attach("t1", "d1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ designId: "d1" });
    expect(h.templates[0].designId).toBe("d1");
  });

  it("locks the template first and then the design, reads and writes only inside the transaction, and writes last", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1" });
    await attach("t1", "d1");
    expect(h.log.filter((x) => x.startsWith("lock:"))).toEqual(["lock:template", "lock:design"]); // never the other way round
    expect(h.log[0]).toBe("tx:begin");
    expect(before("lock:template", "lock:design")).toBe(true);
    expect(before("lock:design", "tx:template.findFirst")).toBe(true); // the reads come after both locks
    expect(before("lock:design", "write:template")).toBe(true);
    expect(h.log.filter((x) => x.startsWith("out:"))).toEqual([]);
    expect(h.log.at(-1)).toBe("tx:end");
  });

  it("the design lock is scoped to the workspace and to template designs", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1" });
    await attach("t1", "d1");
    const lock = db.$queryRaw.mock.calls.find(([s]: [TemplateStringsArray]) => s.join("?").includes('FROM "Design"'))!;
    expect(lock.slice(1)).toEqual(["d1", "ws-1", "template"]);
    expect(lock[0].join("?")).toContain("FOR UPDATE");
  });

  it("answers 409 DESIGN_LINKED when the design already belongs to another template, and writes nothing", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1", designId: "d1" });
    seedTemplate({ id: "t2", category: "Blog Post" });
    const res = await attach("t2", "d1");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "DESIGN_LINKED" });
    expect(db.template.updateMany).not.toHaveBeenCalled();
    expect(h.templates[1].designId).toBeNull();
  });

  it("answers 409 TEMPLATE_HAS_DESIGN when the template already has a design: replacing means removing the link first", async () => {
    seedDesign({ id: "d1" });
    seedDesign({ id: "d2" });
    seedTemplate({ id: "t1", designId: "d1" });
    const res = await attach("t1", "d2");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "TEMPLATE_HAS_DESIGN" });
    expect(h.templates[0].designId).toBe("d1");
    expect(db.template.updateMany).not.toHaveBeenCalled();
  });

  describe("two requests for the same design at the same moment", () => {
    it("the second one's check, made after both locks, sees the first one's committed link: 409, no write", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "t1" });
      seedTemplate({ id: "t2", category: "Blog Post" });
      expect((await attach("t1", "d1")).statusCode).toBe(200);
      h.log = [];
      const second = await attach("t2", "d1");
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ code: "DESIGN_LINKED" });
      expect(h.log).not.toContain("write:template"); // the re-check stopped it before any write
      expect(h.log.filter((x) => x.startsWith("lock:"))).toEqual(["lock:template", "lock:design"]);
      expect(h.templates.map((t) => t.designId)).toEqual(["d1", null]);
    });

    it("if both slip past the locks, the unique index decides: P2002 is 409 DESIGN_LINKED, not a 500", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "t1" });
      h.attachRaces = true; // the write fails the way a unique violation on Template.designId does
      const res = await attach("t1", "d1");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "DESIGN_LINKED" });
      expect(h.templates[0].designId).toBeNull();
    });

    it("any other error from the write is not hidden", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "t1" });
      db.template.updateMany.mockRejectedValueOnce(new Error("db down"));
      expect((await attach("t1", "d1")).statusCode).toBe(500);
    });
  });

  describe("R4: attaching must not strand a published template", () => {
    it("a PUBLISHED legacy template with no link, and a design with no revision: refused, and the template is unchanged and still listed", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "legacy", published: true, linkUrl: null });
      const res = await attach("legacy", "d1");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "DESIGN_NEEDS_REVISION" });
      expect(res.json().error).toContain("Publish a revision of the design first");
      expect(db.template.updateMany).not.toHaveBeenCalled();
      expect(h.templates[0]).toMatchObject({ published: true, linkUrl: null, designId: null }); // not mutated: it keeps the status it had, and no design
    });

    it("the same for a published template whose link is not a Figma design (https://example.com is not a source)", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "legacy", published: true, linkUrl: "https://example.com" });
      expect((await attach("legacy", "d1")).json()).toMatchObject({ code: "DESIGN_NEEDS_REVISION" });
      expect(h.templates[0]).toMatchObject({ published: true, designId: null });
    });

    it("the same for a blank or whitespace link", async () => {
      for (const linkUrl of ["", "   "]) {
        h.templates = [];
        h.designs = [];
        seedDesign({ id: "d1" });
        seedTemplate({ id: "legacy", published: true, linkUrl });
        expect((await attach("legacy", "d1")).json(), JSON.stringify(linkUrl)).toMatchObject({ code: "DESIGN_NEEDS_REVISION" });
      }
    });

    it("a published template WITH a valid Figma link may attach a design that has no revision (it stays listed through its link)", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "t1", published: true, linkUrl: FIGMA });
      expect((await attach("t1", "d1")).statusCode).toBe(200);
      expect(h.templates[0]).toMatchObject({ published: true, linkUrl: FIGMA, designId: "d1" });
    });

    it("a DRAFT with no source may attach a design that has no revision", async () => {
      seedDesign({ id: "d1" });
      seedTemplate({ id: "t1", published: false, linkUrl: null });
      expect((await attach("t1", "d1")).statusCode).toBe(200);
    });

    it("a published legacy template may attach a design that already has a revision: it gains a real source", async () => {
      seedDesign({ id: "d1" });
      seedRevision("d1", 1);
      seedTemplate({ id: "legacy", published: true, linkUrl: null });
      expect((await attach("legacy", "d1")).statusCode).toBe(200);
      expect(h.templates[0]).toMatchObject({ published: true, designId: "d1" });
    });
  });

  it("answers 404 for a template or a design of another workspace, a design that is not a template one, or an unknown id", async () => {
    seedDesign({ id: "d1" });
    seedDesign({ id: "other-d", workspaceId: "ws-2" });
    seedDesign({ id: "instance", kind: "instance" });
    seedTemplate({ id: "t1" });
    seedTemplate({ id: "other-t", workspaceId: "ws-2" });
    for (const [t, d] of [["other-t", "d1"], ["t1", "other-d"], ["t1", "instance"], ["t1", "nope"], ["nope", "d1"]] as const) {
      expect((await attach(t, d)).statusCode, `${t} ${d}`).toBe(404);
    }
    expect(h.templates.map((t) => t.designId)).toEqual([null, null]);
    expect(db.template.updateMany).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed template id, and refuses a malformed or extra body, with nothing locked", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1" });
    expect((await attach("a%00b", "d1")).statusCode).toBe(404);
    for (const payload of [{}, { designId: "../x" }, { designId: "d1", published: true }, { designId: "d1", templateId: "t2" }, { designId: 5 }]) {
      const res = await app.inject({ method: "PUT", url: "/canvas/templates/t1/design", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("DELETE /canvas/templates/:id/design (detach)", () => {
  it("detaches a draft's design and keeps the design and its revisions", async () => {
    seedDesign({ id: "d1" });
    seedRevision("d1", 1);
    seedTemplate({ id: "t1", designId: "d1", published: false });
    const res = await detach("t1");
    expect(res.statusCode).toBe(200);
    expect(h.templates[0].designId).toBeNull();
    expect(h.designs).toHaveLength(1);
    expect(h.revisions).toHaveLength(1);
    expect(db.design.deleteMany).not.toHaveBeenCalled();
  });

  it("locks the template first, then reads and writes inside the transaction", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1", designId: "d1" });
    await detach("t1");
    expect(h.log[0]).toBe("tx:begin");
    expect(h.log[1]).toBe("lock:template");
    expect(h.log).not.toContain("lock:design"); // detaching never takes the design's lock: no cycle is possible
    expect(h.log.filter((x) => x.startsWith("out:"))).toEqual([]);
  });

  it("R2: a published template whose only source is the Canvas revision cannot lose it (409 SOURCE_REQUIRED), and is unchanged", async () => {
    seedDesign({ id: "d1" });
    seedRevision("d1", 1);
    seedTemplate({ id: "t1", designId: "d1", published: true, linkUrl: null });
    const res = await detach("t1");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "SOURCE_REQUIRED" });
    expect(h.templates[0].designId).toBe("d1");
    expect(db.template.updateMany).not.toHaveBeenCalled();
  });

  it("R2: the same when the template's link is not a Figma design (it is not a source)", async () => {
    seedDesign({ id: "d1" });
    seedRevision("d1", 1);
    seedTemplate({ id: "t1", designId: "d1", published: true, linkUrl: "https://example.com" });
    expect((await detach("t1")).json()).toMatchObject({ code: "SOURCE_REQUIRED" });
  });

  it("a published template that also has a valid Figma link may detach (it keeps a source)", async () => {
    seedDesign({ id: "d1" });
    seedRevision("d1", 1);
    seedTemplate({ id: "t1", designId: "d1", published: true, linkUrl: FIGMA });
    expect((await detach("t1")).statusCode).toBe(200);
    expect(h.templates[0]).toMatchObject({ published: true, designId: null });
  });

  it("R3: a published template whose design has no revision and no Figma link had no source to lose, so it may detach", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1", designId: "d1", published: true, linkUrl: null }); // a state R4 now prevents, but one that must not be a trap
    expect((await detach("t1")).statusCode).toBe(200);
  });

  it("answers 404 for a template with no design, another workspace's template, and an unknown or bad id", async () => {
    seedTemplate({ id: "t1" });
    seedTemplate({ id: "other-t", workspaceId: "ws-2", designId: "d9" });
    for (const id of ["t1", "other-t", "nope", "a%00b"]) expect((await detach(id)).statusCode, id).toBe(404);
    expect(h.templates[1].designId).toBe("d9");
    expect(db.template.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST /canvas/templates/:id/design (create a design for a template, in one step)", () => {
  const createFor = (templateId: string, payload: unknown = {}) => app.inject({ method: "POST", url: `/canvas/templates/${templateId}/design`, payload: payload as object });

  it("creates a blank design named after the category and attaches it, and answers with the design", async () => {
    seedTemplate({ id: "t1", category: "Case Study" });
    const res = await createFor("t1");
    expect(res.statusCode).toBe(201);
    const { design } = res.json();
    expect(design).toMatchObject({ name: "Case Study", version: 1 });
    expect(h.designs).toHaveLength(1);
    expect(h.designs[0]).toMatchObject({ id: design.id, workspaceId: "ws-1", kind: "template", name: "Case Study", document: BLANK_DOCUMENT, createdByUserId: "user-1" });
    expect(h.templates[0].designId).toBe(design.id);
  });

  it("does everything in ONE transaction, template locked first, and links last", async () => {
    seedTemplate({ id: "t1" });
    await createFor("t1");
    expect(h.log[0]).toBe("tx:begin");
    expect(h.log[1]).toBe("lock:template");
    expect(h.log).not.toContain("lock:design"); // the design does not exist yet, so there is nothing to lock first
    expect(h.log.filter((x) => x.startsWith("out:"))).toEqual([]);
    expect(before("write:design", "write:template")).toBe(true);
    expect(h.log.at(-1)).toBe("tx:end");
  });

  it("a failure while linking leaves NO design behind: the transaction is rolled back", async () => {
    seedTemplate({ id: "t1" });
    db.template.updateMany.mockRejectedValueOnce(new Error("db down"));
    const res = await createFor("t1");
    expect(res.statusCode).toBe(500);
    expect(h.designs).toHaveLength(0); // the design that was created is gone with the rollback
    expect(h.templates[0].designId).toBeNull();
    expect(h.log).toContain("tx:rollback");
  });

  it("a link that finds the template already taken in between rolls the new design back too", async () => {
    seedTemplate({ id: "t1" });
    db.template.updateMany.mockImplementationOnce(async () => ({ count: 0 })); // someone linked it after the check
    const res = await createFor("t1");
    expect(res.statusCode).toBe(500);
    expect(h.designs).toHaveLength(0);
  });

  it("a failure while creating the design changes nothing", async () => {
    seedTemplate({ id: "t1" });
    db.design.create.mockRejectedValueOnce(new Error("db down"));
    expect((await createFor("t1")).statusCode).toBe(500);
    expect(h.designs).toHaveLength(0);
    expect(h.templates[0].designId).toBeNull();
  });

  it("a template that already has a design: 409 TEMPLATE_HAS_DESIGN, and no second design is made", async () => {
    seedDesign({ id: "d1" });
    seedTemplate({ id: "t1", designId: "d1" });
    const res = await createFor("t1");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "TEMPLATE_HAS_DESIGN" });
    expect(db.design.create).not.toHaveBeenCalled();
    expect(h.designs).toHaveLength(1);
  });

  it("R4: a PUBLISHED template with no usable source is refused (a new design has no revision), and nothing is created", async () => {
    for (const linkUrl of [null, "", "   ", "https://example.com"]) {
      h.templates = [];
      seedTemplate({ id: "legacy", published: true, linkUrl });
      const res = await createFor("legacy");
      expect(res.statusCode, JSON.stringify(linkUrl)).toBe(409);
      expect(res.json()).toMatchObject({ code: "DESIGN_NEEDS_REVISION" });
      expect(h.templates[0]).toMatchObject({ published: true, designId: null });
    }
    expect(db.design.create).not.toHaveBeenCalled();
    expect(h.designs).toHaveLength(0);
  });

  it("a published template WITH a valid Figma link may, and a draft with no source may", async () => {
    seedTemplate({ id: "fig", published: true, linkUrl: FIGMA });
    seedTemplate({ id: "draft", published: false, linkUrl: null, category: "Blog Post" });
    expect((await createFor("fig")).statusCode).toBe(201);
    expect((await createFor("draft")).statusCode).toBe(201);
    expect(h.designs.map((d) => d.name)).toEqual(["Case Study", "Blog Post"]);
  });

  it("answers 404 for another workspace's template, an unknown id and a bad id, and creates nothing", async () => {
    seedTemplate({ id: "other", workspaceId: "ws-2" });
    for (const id of ["other", "nope", "a%00b"]) expect((await createFor(id)).statusCode, id).toBe(404);
    expect(h.designs).toHaveLength(0);
  });

  it("the client sends nothing: any field (a name, a document, a design id, a workspace) is a 400, and nothing is created", async () => {
    seedTemplate({ id: "t1" });
    for (const payload of [{ name: "x" }, { document: BLANK_DOCUMENT }, { designId: "d9" }, { workspaceId: "ws-2" }, { kind: "instance" }, { createdByUserId: "u" }]) {
      expect((await createFor("t1", payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(h.designs).toHaveLength(0);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("answers 415 for a body that is not JSON", async () => {
    seedTemplate({ id: "t1" });
    const res = await app.inject({ method: "POST", url: "/canvas/templates/t1/design", headers: { "content-type": "text/plain" }, payload: "{}" });
    expect(res.statusCode).toBe(415);
    expect(h.designs).toHaveLength(0);
  });

  it("is for the design team only: 401 signed out, 403 for every other role, and nothing is touched", async () => {
    seedTemplate({ id: "t1" });
    h.authed = false;
    expect((await createFor("t1")).statusCode).toBe(401);
    h.authed = true;
    for (const role of ["member", "owner", "admin", "viewer", null]) {
      h.role = role;
      expect((await createFor("t1")).statusCode, String(role)).toBe(403);
    }
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(h.designs).toHaveLength(0);
  });

  it("the name is the category as the design-name rule accepts it (every category fits in 100 characters)", async () => {
    seedTemplate({ id: "t1", category: "Geospatial Insight/Expertise" });
    expect((await createFor("t1")).json().design.name).toBe("Geospatial Insight/Expertise");
  });
});
