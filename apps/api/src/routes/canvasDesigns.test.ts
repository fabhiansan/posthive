// T7: approved Canvas designs on a post. The two Canvas routes (list, picture upload) and what POST/PATCH /jobs, the publishing steps and the
// runner do with content.canvasDesigns. Prisma is a stateful fake (submissions, reviews, posts, uploads), so "approved", "mine" and "this
// workspace" are decided by real rows, and the Upload lock protocol runs on the shared fake (lib/fakeUploads.ts).
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { designImageProblems } from "../lib/designImage.js";

type Sub = { id: string; workspaceId: string; instanceId: string; number: number; name: string; createdAt: Date; document: unknown };
type Review = { id: string; workspaceId: string; submissionId: string; status: string; decidedAt: Date | null; createdAt: Date };
type Inst = { id: string; workspaceId: string; kind: string; createdByUserId: string; archivedAt: Date | null };
type Post = { id: string; workspaceId: string; userId: string; status: string; approvalStatus: string | null; scheduledFor: Date | null; content: string; commentText: string | null; targets: { id: string; accountId: string; account: { platform: string } }[] };

const h = vi.hoisted(() => ({
  userId: "u-me",
  workspace: "ws-1",
  role: "member",
  insts: [] as Inst[],
  subs: [] as Sub[],
  reviews: [] as Review[],
  posts: new Map<string, Post>(),
  accounts: [] as { id: string; workspaceId: string; platform: string }[],
  uploads: null as null | ReturnType<typeof import("../lib/fakeUploads.js").fakeUploads>,
  files: new Map<string, Buffer>(),
  seq: 0,
  beforeLock: null as null | (() => void), // runs just before the Upload rows are locked (a delete that sneaks in between the check and the lock)
  localStorage: true,
}));

// ── the fake database ───────────────────────────────────────────────────────
const matchSub = (s: Sub, w: Record<string, unknown>): boolean => {
  if ("id" in w && s.id !== w.id) return false;
  if ("workspaceId" in w && s.workspaceId !== w.workspaceId) return false;
  if ("instance" in w) {
    const i = h.insts.find((x) => x.id === s.instanceId);
    const iw = w.instance as Record<string, unknown>;
    if (!i || Object.entries(iw).some(([k, v]) => (i as unknown as Record<string, unknown>)[k] !== v)) return false;
  }
  if ("review" in w) {
    const r = h.reviews.find((x) => x.submissionId === s.id);
    if (!r || r.status !== (w.review as { status: string }).status) return false;
  }
  return true;
};
const matchReview = (r: Review, w: Record<string, unknown>): boolean => {
  if (Array.isArray(w.AND)) return (w.AND as Record<string, unknown>[]).every((x) => matchReview(r, x));
  if (Array.isArray(w.OR)) return (w.OR as Record<string, unknown>[]).some((x) => matchReview(r, x));
  if ("workspaceId" in w && r.workspaceId !== w.workspaceId) return false;
  if ("status" in w && r.status !== w.status) return false;
  if ("id" in w) {
    const c = w.id as { lt: string };
    if (!(r.id < c.lt)) return false;
  }
  if ("createdAt" in w) {
    const c = w.createdAt as Date | { lt: Date };
    if (c instanceof Date ? r.createdAt.getTime() !== c.getTime() : !(r.createdAt.getTime() < c.lt.getTime())) return false;
  }
  if ("submission" in w) {
    const s = h.subs.find((x) => x.id === r.submissionId);
    if (!s || !matchSub(s, w.submission as Record<string, unknown>)) return false;
  }
  return true;
};

vi.mock("../lib/prisma.js", () => {
  const tx = () => ({
    $queryRaw: async (...a: [TemplateStringsArray, ...unknown[]]) => {
      if (a[0].join("?").includes("FOR UPDATE")) h.beforeLock?.();
      return h.uploads!.$queryRaw(...a);
    },
    upload: { updateMany: (a: never) => h.uploads!.upload.updateMany(a), deleteMany: (a: never) => h.uploads!.upload.deleteMany(a) },
    template: { findMany: async () => [] },
    legacyTemplateMedia: { findMany: async () => [] },
    postJob: {
      create: async ({ data }: { data: { content: string; userId: string; workspaceId: string; status: string } }) => {
        const id = `c${String(++h.seq).padStart(24, "0")}`;
        const p = { id, workspaceId: data.workspaceId, userId: data.userId, status: data.status, approvalStatus: null, scheduledFor: null, content: data.content, commentText: null, targets: [] } as Post;
        h.posts.set(id, p);
        return { ...p };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Post> }) => {
        const p = h.posts.get(where.id)!;
        Object.assign(p, data);
        return { ...p };
      },
    },
  });
  const db = {
    designSubmission: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => h.subs.find((s) => matchSub(s, where)) ?? null),
    },
    designReviewRequest: {
      findMany: vi.fn(async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy: Array<Record<string, "asc" | "desc">>; take: number }) => {
        return h.reviews
          .filter((r) => matchReview(r, where))
          .sort((a, b) => {
            for (const part of orderBy) {
              for (const [key, dir] of Object.entries(part)) {
                const av = (a as unknown as Record<string, unknown>)[key];
                const bv = (b as unknown as Record<string, unknown>)[key];
                if (av === bv) continue;
                const cmp = av instanceof Date && bv instanceof Date
                  ? av.getTime() - bv.getTime()
                  : typeof av === "number" && typeof bv === "number"
                    ? av - bv
                    : String(av) < String(bv) ? -1 : 1;
                if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
              }
            }
            return 0;
          })
          .slice(0, take)
          .map((r) => {
            const s = h.subs.find((x) => x.id === r.submissionId)!;
            const i = h.insts.find((x) => x.id === s.instanceId)!;
            return { id: r.id, createdAt: r.createdAt, decidedAt: r.decidedAt, submission: { id: s.id, number: s.number, name: s.name, instanceId: s.instanceId, createdAt: s.createdAt, instance: { archivedAt: i.archivedAt } } };
          });
      }),
    },
    upload: {
      findFirst: vi.fn(async ({ where }: { where: { url: string; userId: string } }) => {
        const r = h.uploads!.rows.get(where.url);
        return r && r.userId === where.userId ? r : null;
      }),
      create: vi.fn(async ({ data }: { data: { url: string; userId: string } }) => {
        h.uploads!.rows.set(data.url, { url: data.url, userId: data.userId, claimedAt: null });
        return data;
      }),
    },
    postJob: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; workspaceId: string } }) => {
        const p = h.posts.get(where.id);
        return p && p.workspaceId === where.workspaceId ? { ...p } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Post> }) => {
        const p = h.posts.get(where.id)!;
        Object.assign(p, data);
        return { ...p };
      }),
    },
    account: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; workspaceId: string } }) => h.accounts.filter((a) => where.id.in.includes(a.id) && a.workspaceId === where.workspaceId)) },
    workspace: { findUnique: vi.fn(async () => ({ plan: "team", approvalRequired: true })) },
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx()),
  };
  return { prisma: db };
});

vi.mock("../lib/canvasAssets.js", async () => {
  const real = await vi.importActual<typeof import("../lib/canvasAssets.js")>("../lib/canvasAssets.js");
  return { ...real, isPrivateAssetStorage: () => h.localStorage };
});
vi.mock("../lib/auth/withAuth.js", async () => {
  const real = await vi.importActual<typeof import("../lib/auth/withAuth.js")>("../lib/auth/withAuth.js");
  return {
    ...real,
    withAuth: async () => {},
    getUser: () => ({ id: h.userId }),
    getWorkspaceId: () => h.workspace,
    getWorkspaceRole: async () => h.role,
    requireContentEditorRole: async () => (["owner", "admin", "member"].includes(h.role) ? null : { error: "Content is created and edited by Admin and Marketing only.", code: "FORBIDDEN" }),
  };
});
vi.mock("../lib/queue.js", () => ({ schedulePostJob: vi.fn(), postJobQueue: { remove: vi.fn(async () => {}) } }));
vi.mock("../lib/enforcePlan.js", () => ({ enforcePlan: async () => null }));
vi.mock("../lib/auth/index.js", () => ({ authProvider: {} }));
vi.mock("../adapters/index.js", () => ({ adapters: [] }));

import { jobRoutes } from "./jobs.js";
import { canvasDesignRoutes } from "./canvasDesigns.js";
import { fakeUploads } from "../lib/fakeUploads.js";
import { releaseMedia } from "../lib/mediaDelete.js";
import { signCursor } from "../lib/canvasDesigns.js";
import { prisma } from "../lib/prisma.js";
import { encodeCursor } from "../lib/canvas.js";

// ── helpers ─────────────────────────────────────────────────────────────────
const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
};
const pngOf = (w: number, h2: number, body = 0) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h2, 4);
  return Buffer.concat([MAGIC, chunk("IHDR", ihdr), chunk("IDAT", Buffer.alloc(body)), IEND]);
};
const multipartOf = (file: Buffer, type = "image/png", name = "design.png") => {
  const b = "----t7";
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), file, Buffer.from(`\r\n--${b}--\r\n`)]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${b}` } };
};

const storage = {
  upload: vi.fn(async (buf: Buffer, _mime: string, folder?: string) => {
    const url = `/uploads/${folder ? `${folder}/` : ""}f${++h.seq}.png`;
    h.files.set(url, buf);
    return url;
  }),
  getBuffer: vi.fn(async (url: string) => {
    const f = h.files.get(url);
    if (!f) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return f;
  }),
  delete: vi.fn(async (url: string) => void h.files.delete(url)),
  listFolder: vi.fn(),
  ownsUrl: () => true,
};

const SUB = (n: number) => `sub${n}`;
let t = 0;
/** One submission of an instance with a review of the given status. Defaults: mine, this workspace, 1080x1350. */
function seed(n: number, o: { status?: string; owner?: string; ws?: string; instance?: string; archived?: boolean; w?: number; h?: number; at?: number } = {}) {
  const inst = o.instance ?? `inst${n}`;
  if (!h.insts.some((i) => i.id === inst)) h.insts.push({ id: inst, workspaceId: o.ws ?? "ws-1", kind: "instance", createdByUserId: o.owner ?? "u-me", archivedAt: o.archived ? new Date() : null });
  h.subs.push({ id: SUB(n), workspaceId: o.ws ?? "ws-1", instanceId: inst, number: n, name: `Design ${n}`, createdAt: new Date(1_700_000_000_000 + n), document: { width: o.w ?? 1080, height: o.h ?? 1350 } });
  const at = new Date(1_700_000_000_000 + (o.at ?? ++t) * 1000);
  h.reviews.push({ id: `rev${String(n).padStart(3, "0")}`, workspaceId: o.ws ?? "ws-1", submissionId: SUB(n), status: o.status ?? "approved", decidedAt: at, createdAt: at });
}
/** The picture of submission n as the Canvas route would have stored it: a file under its folder and an Upload row of the caller. */
function stored(n: number, o: { w?: number; h?: number; owner?: string; body?: number } = {}) {
  const url = `/uploads/canvas-designs/${SUB(n)}/p${n}.png`;
  h.files.set(url, pngOf(o.w ?? 1080, o.h ?? 1350, o.body ?? 20));
  h.uploads!.rows.set(url, { url, userId: o.owner ?? "u-me", claimedAt: null });
  return url;
}
const ACC = (platform: string, id = `c${String(900 + h.accounts.length).padStart(24, "0")}`) => (h.accounts.push({ id, workspaceId: "ws-1", platform }), id); // a cuid-shaped id (the route validates the shape)

let app: FastifyInstance;
beforeAll(async () => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  app = Fastify();
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 4 } }); // mirror production; the route must enforce its own 10 MB cap
  await app.register(jobRoutes, { storage } as never);
  await app.register(canvasDesignRoutes, { storage } as never);
  await app.ready();
});
afterAll(async () => void (await app.close()));
beforeEach(() => {
  h.userId = "u-me";
  h.workspace = "ws-1";
  h.role = "member";
  h.insts = [];
  h.subs = [];
  h.reviews = [];
  h.posts.clear();
  h.accounts = [];
  h.files.clear();
  h.seq = 0;
  t = 0;
  h.beforeLock = null;
  h.localStorage = true;
  // The real scan is strpos over the post's whole content text, so a picture counts as held wherever in the content its address appears
  h.uploads = fakeUploads([], () => [...h.uploads!.rows.keys()].filter((u) => [...h.posts.values()].some((p) => p.content.includes(u))));
  storage.delete.mockClear();
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
});

const list = (qs = "", user = h.userId) => {
  h.userId = user;
  return app.inject({ method: "GET", url: `/canvas/approved${qs}` });
};
const image = (id: string, file: Buffer, type?: string) => app.inject({ method: "POST", url: `/canvas/submissions/${id}/image`, ...multipartOf(file, type) });
const create = (content: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: "/jobs", payload: { draft: true, content: { text: "x", ...content }, ...extra } });
const patch = (id: string, body: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/jobs/${id}`, payload: body });
const contentOf = (id: string) => JSON.parse(h.posts.get(id)!.content) as { mediaUrls: string[]; canvasDesigns?: { submissionId: string; mediaUrl: string; bytes?: number }[] };
const body = (r: { body: string }) => JSON.parse(r.body);

// ── GET /canvas/approved ────────────────────────────────────────────────────
describe("GET /canvas/approved: who sees which design", () => {
  it("lists every APPROVED version of my designs, newest first, with no document", async () => {
    seed(1, { instance: "i1" });
    seed(2, { instance: "i1", status: "changes_requested" });
    seed(3, { instance: "i1" });
    seed(4, { instance: "i1", status: "superseded" });
    seed(5, { instance: "i1", status: "pending" });
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { designs, nextCursor } = body(res);
    expect(designs.map((d: { number: number }) => d.number)).toEqual([3, 1]); // v1 stays selectable after v3 was approved; the others never were
    expect(nextCursor).toBeNull();
    expect(Object.keys(designs[0]).sort()).toEqual(["approvedAt", "archived", "instanceId", "name", "number", "submissionId", "submittedAt"]);
  });

  it("never lists another person's, another workspace's, or a design that was never submitted", async () => {
    seed(1, { owner: "u-other" });
    seed(2, { ws: "ws-2" });
    h.insts.push({ id: "draft-only", workspaceId: "ws-1", kind: "instance", createdByUserId: "u-me", archivedAt: null }); // a saved Canvas design draft: no submission, no review
    seed(3, { status: "pending" });
    seed(4);
    expect(body(await list()).designs.map((d: { number: number }) => d.number)).toEqual([4]);
    expect(body(await list("", "u-other")).designs.map((d: { number: number }) => d.number)).toEqual([1]);
  });

  it("an archived design's approved versions stay selectable, marked archived", async () => {
    seed(1, { archived: true });
    expect(body(await list()).designs[0].archived).toBe(true);
  });

  it("is for Marketing only: a designer, or an unknown role, gets 403", async () => {
    for (const role of ["designer", "viewer"]) {
      h.role = role;
      expect((await list()).statusCode).toBe(403);
    }
  });

  it("pages with a signed cursor: several pages, no duplicate and no skipped version, equal times ordered by id", async () => {
    for (let n = 1; n <= 7; n++) seed(n, { at: n <= 3 ? 1 : n }); // the first three share an instant
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await list(`?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.statusCode).toBe(200);
      const b = body(res);
      seen.push(...b.designs.map((d: { number: number }) => d.number));
      cursor = b.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]); // exact keyset order, including id DESC for the equal timestamps
    expect(new Set(seen).size).toBe(7);
  });

  it("a version approved between two pages neither repeats nor breaks the walk", async () => {
    for (let n = 1; n <= 4; n++) seed(n);
    const first = body(await list("?limit=2"));
    seed(5, { at: 100 }); // newer than everything: it belongs to a page already walked past
    const second = body(await list(`?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`));
    expect([...first.designs, ...second.designs].map((d: { number: number }) => d.number)).toEqual([4, 3, 2, 1]);
  });

  describe("a cursor that is not exactly what the server issued to THIS person in THIS workspace is a 400 INVALID_CURSOR", () => {
    const refused = async (raw: string, user = "u-me") => {
      const res = await list(`?cursor=${encodeURIComponent(raw)}`, user);
      return [res.statusCode, body(res).code];
    };
    const good = () => signCursor({ createdAt: new Date(1_700_000_000_000), id: "rev001" }, "ws-1", "u-me");

    beforeEach(() => {
      for (let n = 1; n <= 3; n++) seed(n);
    });

    it("issued to user A, replayed by user B of the same workspace", async () => {
      seed(9, { owner: "u-b" });
      expect(await refused(good(), "u-b")).toEqual([400, "INVALID_CURSOR"]);
    });

    it("issued in workspace 1, replayed by the same person in workspace 2", async () => {
      const other = signCursor({ createdAt: new Date(1_700_000_000_000), id: "rev001" }, "ws-2", "u-me");
      expect(await refused(other)).toEqual([400, "INVALID_CURSOR"]);
    });

    it("a well-shaped payload that was changed, keeping the old MAC, and a MAC with a bit flipped", async () => {
      const [, mac] = good().split(".");
      expect(await refused(`${encodeCursor({ createdAt: new Date(1), id: "rev001" })}.${mac}`)).toEqual([400, "INVALID_CURSOR"]);
      const bytes = Buffer.from(mac, "base64url");
      bytes[31] ^= 0x80;
      expect(await refused(`${good().split(".")[0]}.${bytes.toString("base64url")}`)).toEqual([400, "INVALID_CURSOR"]);
    });

    it("a truncated, oversized, empty or non-base64url MAC, no dot, two dots, and a plain unsigned cursor (a 400, never a 500)", async () => {
      const [payload, mac] = good().split(".");
      const bad = [`${payload}.${Buffer.alloc(31).toString("base64url")}`, `${payload}.${Buffer.alloc(33).toString("base64url")}`, `${payload}.`, `${payload}.@@@@`, payload, `${payload}.${mac}.${mac}`, encodeCursor({ createdAt: new Date(1_700_000_000_000), id: "rev001" }), "x".repeat(400)];
      for (const raw of bad) expect(await refused(raw), raw.slice(0, 30)).toEqual([400, "INVALID_CURSOR"]);
    });

    it("no signing key: the list answers 503 and issues no unsigned cursor", async () => {
      delete process.env.ENCRYPTION_KEY;
      const res = await list();
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toMatch(/cursor":"/);
    });

    it("a bad limit is a 400 too", async () => {
      expect((await list("?limit=0")).statusCode).toBe(400);
      expect((await list("?limit=abc")).statusCode).toBe(400);
    });
  });

  it("every query carries the owner and the workspace, whatever the cursor says", async () => {
    seed(1);
    const c = signCursor({ createdAt: new Date(1_800_000_000_000), id: "zzz" }, "ws-1", "u-me");
    await list(`?cursor=${encodeURIComponent(c)}`);
    const where = vi.mocked(prisma.designReviewRequest.findMany).mock.calls.at(-1)![0] as unknown as { where: { AND: [{ workspaceId: string; submission: { instance: { createdByUserId: string; workspaceId: string } } }] } };
    expect(where.where.AND[0]).toMatchObject({ workspaceId: "ws-1", submission: { instance: { createdByUserId: "u-me", workspaceId: "ws-1" } } });
  });
});

// ── POST /canvas/submissions/:id/image ──────────────────────────────────────
describe("POST /canvas/submissions/:id/image", () => {
  it("refuses non-local storage with 501 instead of returning a URL that cannot later be attached", async () => {
    h.localStorage = false;
    const res = await image(SUB(1), pngOf(1080, 1350));
    expect([res.statusCode, body(res).code]).toEqual([501, "CANVAS_STORAGE_UNSUPPORTED"]);
    expect(prisma.designSubmission.findFirst).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("stores the PNG UNCHANGED under the submission's folder and records it as the caller's upload", async () => {
    seed(1);
    const file = pngOf(1080, 1350, 300);
    const res = await image(SUB(1), file);
    expect(res.statusCode).toBe(201);
    const { url, bytes } = body(res);
    expect(url).toMatch(new RegExp(`^/uploads/canvas-designs/${SUB(1)}/`));
    expect(bytes).toBe(file.length);
    expect(h.files.get(url)!.equals(file)).toBe(true); // byte for byte: no re-encoding, no conversion
    expect(h.uploads!.rows.get(url)).toMatchObject({ userId: "u-me", claimedAt: null });
  });

  it("refuses another person's, another workspace's, pending, changes-requested, superseded and unknown submissions with 404, storing nothing", async () => {
    seed(1, { owner: "u-other" });
    seed(2, { ws: "ws-2" });
    seed(3, { status: "pending" });
    seed(4, { status: "changes_requested" });
    seed(5, { status: "superseded" });
    for (const id of [SUB(1), SUB(2), SUB(3), SUB(4), SUB(5), "nope"]) expect((await image(id, pngOf(1080, 1350))).statusCode, id).toBe(404);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(h.uploads!.rows.size).toBe(0);
  });

  it("the lookup itself is scoped to the active workspace: the query carries the workspace, not only the owner", async () => {
    seed(1);
    await image(SUB(1), pngOf(1080, 1350));
    const where = vi.mocked(prisma.designSubmission.findFirst).mock.calls.at(-1)![0] as unknown as { where: { workspaceId: string; instance: { workspaceId: string } } };
    expect(where.where).toMatchObject({ id: SUB(1), workspaceId: "ws-1", instance: { workspaceId: "ws-1" } });
    // and a submission of mine in ANOTHER workspace is refused for a caller whose active workspace is ws-1
    seed(2, { ws: "ws-2" });
    expect((await image(SUB(2), pngOf(1080, 1350))).statusCode).toBe(404);
  });

  it("a designer gets 403 and nothing is stored", async () => {
    seed(1);
    h.role = "designer";
    expect((await image(SUB(1), pngOf(1080, 1350))).statusCode).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("judges the BYTES, not the name or the content type: a JPEG called .png is refused, a PNG sent as text/plain is accepted", async () => {
    seed(1);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300)]);
    const bad = await image(SUB(1), jpeg, "image/png");
    expect([bad.statusCode, body(bad).code]).toEqual([400, "NOT_PNG"]);
    expect((await image(SUB(1), pngOf(1080, 1350), "text/plain")).statusCode).toBe(201);
  });

  it("refuses a truncated PNG, malformed dimensions and the wrong size with exact 4xx codes, storing nothing", async () => {
    seed(1);
    const whole = pngOf(1080, 1350, 50);
    const bad: Array<[Buffer, string]> = [
      [whole.subarray(0, whole.length - 3), "NOT_PNG"],
      [pngOf(0, 0), "NOT_PNG"],
      [pngOf(1080, 1349), "SIZE_MISMATCH"],
      [pngOf(1350, 1080), "SIZE_MISMATCH"],
      [pngOf(9000, 9000), "NOT_PNG"],
      [Buffer.alloc(0), "NOT_PNG"],
      [Buffer.from("not a png"), "NOT_PNG"],
    ];
    for (const [file, code] of bad) {
      const res = await image(SUB(1), file);
      expect([res.statusCode, body(res).code], code).toEqual([400, code]);
    }
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("refuses multipart text fields instead of allocating them (only one file part is accepted)", async () => {
    seed(1);
    const boundary = "----t7fields";
    const file = pngOf(1080, 1350);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nx\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="design.png"\r\nContent-Type: image/png\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({ method: "POST", url: `/canvas/submissions/${SUB(1)}/image`, payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
    expect([400, 413]).toContain(res.statusCode);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("refuses a second file part even when the app-wide multipart limit allows several", async () => {
    seed(1);
    const boundary = "----t7twofiles";
    const file = pngOf(1080, 1350);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), file,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n`), file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({ method: "POST", url: `/canvas/submissions/${SUB(1)}/image`, payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
    expect(res.statusCode).toBe(400);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("answers an oversized file with 413, and no file at all with 400", async () => {
    seed(1);
    expect((await image(SUB(1), pngOf(1080, 1350, 10_000_100))).statusCode).toBe(413);
    const res = await app.inject({ method: "POST", url: `/canvas/submissions/${SUB(1)}/image`, payload: "", headers: { "content-type": "multipart/form-data; boundary=x" } });
    expect(res.statusCode).toBe(400);
  });

  it("removes the stored file when the Upload row cannot be written, so no file is left that nothing points at", async () => {
    seed(1);
    vi.mocked(prisma.upload.create).mockRejectedValueOnce(new Error("db down"));
    expect((await image(SUB(1), pngOf(1080, 1350))).statusCode).toBe(500);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(h.files.size).toBe(0);
  });
});

// ── attaching to a post ─────────────────────────────────────────────────────
describe("POST /jobs with canvasDesigns", () => {
  it("stores the entry from the server's own record, with the size it measured", async () => {
    seed(1);
    const url = stored(1, { body: 500 });
    const res = await create({ mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }] });
    expect(res.statusCode).toBe(201);
    const c = contentOf(body(res).id);
    expect(c.canvasDesigns).toEqual([{ submissionId: SUB(1), mediaUrl: url, bytes: h.files.get(url)!.length }]);
    expect(c.mediaUrls).toEqual([url]); // the invariant: a design's picture is also in mediaUrls
    expect(h.uploads!.rows.get(url)!.claimedAt).not.toBeNull(); // claimed in the same transaction as the post
  });

  it("client-supplied claims cannot change what is stored: extra keys, a made-up size, approval and workspace flags are dropped", async () => {
    seed(1);
    const url = stored(1);
    const res = await create({ mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url, bytes: 1, approved: true, workspaceId: "ws-9", width: 1, height: 1 }] });
    expect(res.statusCode).toBe(201);
    expect(contentOf(body(res).id).canvasDesigns).toEqual([{ submissionId: SUB(1), mediaUrl: url, bytes: h.files.get(url)!.length }]);
  });

  it("refuses (409) a design that is not an approved design of mine, creating no post and claiming no file", async () => {
    seed(1, { owner: "u-other" });
    seed(2, { ws: "ws-2" });
    seed(3, { status: "pending" });
    seed(4, { status: "changes_requested" });
    seed(5, { status: "superseded" });
    for (const n of [1, 2, 3, 4, 5]) {
      const url = stored(n, { owner: "u-me" });
      const res = await create({ mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(n), mediaUrl: url }] });
      expect([res.statusCode, body(res).code], `sub ${n}`).toEqual([409, "DESIGN_NOT_APPROVED"]);
      expect(h.uploads!.rows.get(url)!.claimedAt).toBeNull();
    }
    expect(h.posts.size).toBe(0);
    expect((await create({ mediaUrls: ["/uploads/x.png"], canvasDesigns: [{ submissionId: "unknown", mediaUrl: "/uploads/canvas-designs/unknown/x.png" }] })).statusCode).toBe(409);
  });

  it("refuses a picture that is not the picture of that submission (another folder, a plain upload, another submission's file)", async () => {
    seed(1);
    seed(2);
    const own = stored(1);
    const theirs = stored(2);
    h.uploads!.rows.set("/uploads/plain.png", { url: "/uploads/plain.png", userId: "u-me", claimedAt: null });
    h.files.set("/uploads/plain.png", pngOf(1080, 1350));
    // an outside host whose address merely CONTAINS this submission's folder is not a stored file: refused before storage is asked for it
    const external = `https://evil.example/uploads/canvas-designs/${SUB(1)}/x.png`;
    const nested = `/uploads/other/canvas-designs/${SUB(1)}/x.png`;
    for (const url of ["/uploads/plain.png", theirs, external, nested]) {
      const res = await create({ mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }] });
      expect([res.statusCode, body(res).code], url).toEqual([409, "DESIGN_IMAGE_MISMATCH"]);
    }
    expect(storage.getBuffer).not.toHaveBeenCalledWith(external);
    expect(storage.getBuffer).not.toHaveBeenCalledWith(nested);
    expect((await create({ mediaUrls: [own], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: own }] })).statusCode).toBe(201);
  });

  it("refuses a stored file that is not a PNG of the approved size, or that is gone (409), and a malformed entry (400)", async () => {
    seed(1);
    const wrong = stored(1, { w: 1000, h: 1000 });
    const r1 = await create({ mediaUrls: [wrong], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: wrong }] });
    expect([r1.statusCode, body(r1).code]).toEqual([409, "DESIGN_IMAGE_INVALID"]);
    const url = stored(1);
    h.files.set(url, Buffer.from("<html>"));
    expect(body(await create({ mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }] })).code).toBe("DESIGN_IMAGE_INVALID");
    h.files.delete(url);
    expect(body(await create({ mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }] })).code).toBe("MEDIA_UNAVAILABLE");
    for (const bad of [[{ submissionId: "../x", mediaUrl: "/u" }], [{ submissionId: SUB(1) }], "x", Array.from({ length: 11 }, () => ({ submissionId: "a", mediaUrl: "b" }))]) {
      expect((await create({ mediaUrls: [], canvasDesigns: bad })).statusCode).toBe(400);
    }
  });

  it("refuses a picture that is not the caller's own upload (another person's file under the submission's folder)", async () => {
    seed(1);
    const url = stored(1, { owner: "u-other" });
    const res = await create({ mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }] });
    expect(res.statusCode).toBe(409);
    expect(h.posts.size).toBe(0);
  });

  it("an entry whose picture is not on the post is dropped, never stored", async () => {
    seed(1);
    const url = stored(1);
    const res = await create({ mediaUrls: [], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }] });
    expect(res.statusCode).toBe(201);
    expect(contentOf(body(res).id).canvasDesigns).toBeUndefined();
  });

  it("the API's own origin in front of the address is stored as the stored path", async () => {
    process.env.PUBLIC_API_URL = "https://api.example";
    try {
      seed(1);
      const url = stored(1);
      const res = await create({ mediaUrls: [`https://api.example${url}`], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: `https://api.example${url}` }] });
      expect(res.statusCode).toBe(201);
      expect(contentOf(body(res).id)).toMatchObject({ mediaUrls: [url], canvasDesigns: [{ mediaUrl: url }] });
    } finally {
      delete process.env.PUBLIC_API_URL;
    }
  });

  it("refuses a Canvas-design path hidden in a YouTube media field", async () => {
    seed(1);
    const url = stored(1);
    const res = await create({ mediaUrls: [], youtubeThumbnailUrl: url, youtubeVideoUrl: "https://youtu.be/x" });
    expect([res.statusCode, body(res).code]).toEqual([400, "DESIGN_METADATA_REQUIRED"]);
    expect(h.posts.size).toBe(0);
  });

  it("refuses a Canvas-design picture attached without its validated metadata", async () => {
    seed(1);
    const url = stored(1);
    const res = await create({ mediaUrls: [url] });
    expect([res.statusCode, body(res).code]).toEqual([409, "DESIGN_METADATA_REQUIRED"]);
    expect(h.posts.size).toBe(0);
    expect(h.uploads!.rows.get(url)!.claimedAt).toBeNull();
  });

  it("a post with no designs is stored exactly as before (no canvasDesigns key)", async () => {
    const res = await create({ mediaUrls: [] });
    expect("canvasDesigns" in contentOf(body(res).id)).toBe(false);
  });
});

describe("PATCH /jobs/:id: attach, remove, and what stays", () => {
  const draft = async (n = 1) => {
    seed(n);
    const url = stored(n);
    const res = await create({ mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(n), mediaUrl: url }] });
    return { id: body(res).id as string, url };
  };

  it("removing the picture removes its canvasDesigns entry, and the file is released", async () => {
    const { id, url } = await draft();
    const res = await patch(id, { mediaUrls: [] });
    expect(res.statusCode).toBe(200);
    expect(contentOf(id).canvasDesigns).toBeUndefined();
    expect(contentOf(id).mediaUrls).toEqual([]);
    expect(storage.delete).toHaveBeenCalledWith(url);
    expect(h.uploads!.rows.has(url)).toBe(false);
  });

  it("removing one of two designs keeps the other, entry and file", async () => {
    seed(1);
    seed(2);
    const a = stored(1);
    const b = stored(2);
    const id = body(await create({ mediaUrls: [a, b], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: a }, { submissionId: SUB(2), mediaUrl: b }] })).id;
    await patch(id, { mediaUrls: [b] });
    expect(contentOf(id).canvasDesigns).toEqual([{ submissionId: SUB(2), mediaUrl: b, bytes: h.files.get(b)!.length }]);
    expect(h.uploads!.rows.has(b)).toBe(true);
    expect(h.uploads!.rows.has(a)).toBe(false);
  });

  it("a file another post still holds is KEPT when this post drops it", async () => {
    const { id, url } = await draft();
    h.posts.set("other", { ...h.posts.get(id)!, id: "other" }); // a duplicate / repeat still holds the same file
    await patch(id, { mediaUrls: [] });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(h.uploads!.rows.has(url)).toBe(true);
  });

  it("a later edit that does not touch the pictures keeps the stored entry as it was", async () => {
    const { id } = await draft();
    const before = contentOf(id).canvasDesigns;
    expect((await patch(id, { text: "new caption" })).statusCode).toBe(200);
    expect(contentOf(id).canvasDesigns).toEqual(before);
    expect((await patch(id, { mediaUrls: contentOf(id).mediaUrls })).statusCode).toBe(200); // the editor resends the list unchanged
    expect(contentOf(id).canvasDesigns).toEqual(before);
  });

  it("attaches a second design to an existing draft; a client cannot rewrite the size of one already stored", async () => {
    const { id, url } = await draft(1);
    seed(2);
    const b = stored(2);
    const res = await patch(id, { mediaUrls: [url, b], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url, bytes: 1 } as never, { submissionId: SUB(2), mediaUrl: b }] });
    expect(res.statusCode).toBe(200);
    expect(contentOf(id).canvasDesigns!.map((d) => [d.submissionId, d.bytes])).toEqual([[SUB(1), h.files.get(url)!.length], [SUB(2), h.files.get(b)!.length]]);
  });

  it("refuses a new design that is not mine and approved, and changes nothing", async () => {
    const { id, url } = await draft(1);
    seed(2, { owner: "u-other" });
    const b = stored(2);
    const before = h.posts.get(id)!.content;
    const res = await patch(id, { mediaUrls: [url, b], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }, { submissionId: SUB(2), mediaUrl: b }] });
    expect([res.statusCode, body(res).code]).toEqual([409, "DESIGN_NOT_APPROVED"]);
    expect(h.posts.get(id)!.content).toBe(before);
  });

  it("clearing metadata while keeping a Canvas-design picture is refused, so provenance cannot be bypassed", async () => {
    const { id, url } = await draft();
    const before = h.posts.get(id)!.content;
    const res = await patch(id, { canvasDesigns: [] });
    expect([res.statusCode, body(res).code]).toEqual([409, "DESIGN_METADATA_REQUIRED"]);
    expect(h.posts.get(id)!.content).toBe(before);
    expect(h.uploads!.rows.get(url)!.claimedAt).not.toBeNull();
  });

  it("an entry sent for a picture the post does not have is dropped without disturbing the post's ordinary picture", async () => {
    seed(1);
    const plain = "/uploads/plain.png";
    h.uploads!.rows.set(plain, { url: plain, userId: "u-me", claimedAt: null });
    h.files.set(plain, pngOf(1080, 1350));
    const id = body(await create({ mediaUrls: [plain] })).id;
    seed(2);
    const b = stored(2);
    await patch(id, { canvasDesigns: [{ submissionId: SUB(2), mediaUrl: b }] }); // b is not on the post
    const c = contentOf(id);
    expect(c.canvasDesigns).toBeUndefined(); // no empty list is left behind
    expect(c.mediaUrls).toEqual([plain]);
    expect(h.uploads!.rows.has(b)).toBe(true);
    expect(h.uploads!.rows.get(b)!.claimedAt).toBeNull();
  });
});

describe("media lock protocol with canvasDesigns (Gate S)", () => {
  it("the scan sees a picture held only under canvasDesigns, so releaseMedia keeps it", async () => {
    const url = "/uploads/canvas-designs/s/p.png";
    h.uploads!.rows.set(url, { url, userId: "u-me", claimedAt: new Date() });
    h.posts.set("held", { id: "held", workspaceId: "ws-1", userId: "u-me", status: "draft", approvalStatus: null, scheduledFor: null, commentText: null, targets: [], content: JSON.stringify({ canvasDesigns: [{ submissionId: "s", mediaUrl: url }] }) });
    await releaseMedia(storage as never, [url], ["u-me"]);
    expect(storage.delete).not.toHaveBeenCalled();
    h.posts.delete("held");
    await releaseMedia(storage as never, [url], ["u-me"]);
    expect(storage.delete).toHaveBeenCalledWith(url);
  });

  it("attach racing a delete, delete FIRST: the attach is a 409 and no reference to a missing file is stored", async () => {
    seed(1);
    const url = stored(1);
    // the file's Upload row is deleted (DELETE /upload, the orphan cleaner) after the design was checked and before the attach locks it
    h.beforeLock = () => {
      h.uploads!.rows.delete(url);
      h.files.delete(url);
    };
    const res = await create({ mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }] });
    expect(res.statusCode).toBe(409);
    expect(h.posts.size).toBe(0);
  });

  it("attach racing a delete, attach FIRST: the claim is held under the lock, so the later delete keeps the file", async () => {
    seed(1);
    const url = stored(1);
    expect((await create({ mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }] })).statusCode).toBe(201);
    await releaseMedia(storage as never, [url], ["u-me"]); // DELETE /upload arriving afterwards
    expect(storage.delete).not.toHaveBeenCalled();
    expect(h.files.has(url)).toBe(true);
  });

  it("a metadata-only PATCH locks the final picture and refuses if a concurrent remove deleted its Upload row", async () => {
    seed(1);
    const url = stored(1);
    const id = body(await create({ mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }] })).id;
    h.beforeLock = () => {
      const p = h.posts.get(id)!;
      p.content = JSON.stringify({ ...JSON.parse(p.content), mediaUrls: [], canvasDesigns: [] }); // request B removed the picture
      h.uploads!.rows.delete(url);
      h.files.delete(url);
    };
    const res = await patch(id, { canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }] });
    expect(res.statusCode).toBe(409);
    expect(contentOf(id).mediaUrls).toEqual([]); // the stale metadata edit did not resurrect the removed picture
    expect(h.files.has(url)).toBe(false);
  });

  it("a text-only PATCH also locks the final Canvas picture and cannot resurrect a concurrent removal", async () => {
    seed(1);
    const url = stored(1);
    const id = body(await create({ mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }] })).id;
    h.beforeLock = () => {
      const p = h.posts.get(id)!;
      p.content = JSON.stringify({ ...JSON.parse(p.content), text: "Other edit", mediaUrls: [], canvasDesigns: [] });
      h.uploads!.rows.delete(url);
      h.files.delete(url);
    };
    const res = await patch(id, { text: "Stale edit" });
    expect(res.statusCode).toBe(409);
    expect(contentOf(id).mediaUrls).toEqual([]);
    expect(JSON.parse(h.posts.get(id)!.content).text).toBe("Other edit");
  });

  it("the attach locks the picture's Upload row inside its own transaction", async () => {
    seed(1);
    const url = stored(1);
    await create({ mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }] });
    expect(h.uploads!.calls("lock").some((l) => (l.args as string[]).includes(url))).toBe(true);
  });
});

// ── publishing: a channel that cannot take the picture ──────────────────────
describe("platform compatibility of an approved design (the PNG is never converted)", () => {
  it("POST /jobs (scheduling, not a draft) to Instagram is refused 409 with the reason; a draft is allowed", async () => {
    seed(1);
    const url = stored(1);
    const acc = ACC("instagram");
    const content = { mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url }] };
    const draftRes = await create(content, { accountIds: [acc] });
    expect(draftRes.statusCode).toBe(201);
    const res = await app.inject({ method: "POST", url: "/jobs", payload: { draft: false, scheduledFor: "2030-01-01T00:00:00.000Z", accountIds: [acc], content: { text: "x", ...content } } });
    expect([res.statusCode, body(res).code]).toEqual([409, "DESIGN_IMAGE_INCOMPATIBLE"]);
    expect(body(res).problems[0]).toMatch(/Instagram.*JPEG/);
  });

  it("POST /jobs/:id/submit refuses it, naming the channel; the same post to a channel with no rule goes through", async () => {
    seed(1);
    const url = stored(1);
    const ig = ACC("instagram");
    const content = JSON.stringify({ title: "t", text: "x", category: "Case Study", format: "single", mediaUrls: [url], canvasDesigns: [{ submissionId: SUB(1), mediaUrl: url, bytes: 100 }] });
    const post = (platform: string, accId: string) => {
      const p: Post = { id: `c${String(++h.seq).padStart(24, "0")}`, workspaceId: "ws-1", userId: "u-me", status: "draft", approvalStatus: null, scheduledFor: new Date("2030-01-01"), content, commentText: null, targets: [{ id: "t", accountId: accId, account: { platform } }] };
      h.posts.set(p.id, p);
      return p.id;
    };
    // the submit route also reads designRequest: the fake returns none
    for (const fn of [vi.mocked(prisma.postJob.findFirst)]) fn.mockImplementation((async ({ where }: { where: { id: string } }) => ({ ...h.posts.get(where.id), designRequest: null })) as never);
    const blocked = await app.inject({ method: "POST", url: `/jobs/${post("instagram", ig)}/submit` });
    expect([blocked.statusCode, body(blocked).code]).toEqual([409, "DESIGN_IMAGE_INCOMPATIBLE"]);
    const ok = await app.inject({ method: "POST", url: `/jobs/${post("mastodon", "a-m")}/submit` });
    expect(ok.statusCode).toBe(200);
  });

  it("the runner backstop: designImageProblems names the channel and the limit that stopped it", () => {
    const entry = { submissionId: "s", mediaUrl: "/uploads/p.png", bytes: 6_000_000 };
    expect(designImageProblems({ canvasDesigns: [entry] }, ["linkedin"])[0]).toMatch(/LinkedIn accepts pictures up to 5\.00 MB.*6\.00 MB.*does not shrink/);
  });
});
