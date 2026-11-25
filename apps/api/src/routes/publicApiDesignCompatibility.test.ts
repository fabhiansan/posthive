// T7: the public REST API is a publishing path too. Retargeting or approving a post with an approved Canvas design must refuse an
// incompatible final channel before any content/target write or queue call.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../lib/storage.js";

const h = vi.hoisted(() => ({
  job: null as null | Record<string, any>,
  accounts: [] as Array<{ id: string; platform: string }>,
  updates: [] as Array<Record<string, any>>,
  created: [] as Array<Record<string, any>>,
  released: [] as string[][],
  locked: [] as string[][],
  missingCanvas: false,
  targetDeletes: vi.fn(async () => ({ count: 1 })),
  targetCreates: vi.fn(async () => ({ count: 1 })),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    account: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => h.accounts.filter((a) => where.id.in.includes(a.id))) },
    postJob: {
      findFirst: vi.fn(async () => h.job),
      update: vi.fn(async (args: { data: Record<string, any> }) => {
        h.updates.push(args);
        return { ...h.job, ...args.data };
      }),
      create: vi.fn(async (args: { data: Record<string, any> }) => {
        h.created.push(args.data);
        return { id: "new", status: args.data.status, scheduledFor: args.data.scheduledFor, targets: [] };
      }),
    },
    postJobTarget: { deleteMany: h.targetDeletes, createMany: h.targetCreates },
  },
}));
vi.mock("../lib/queue.js", () => ({ schedulePostJob: vi.fn(async () => {}), postJobQueue: { remove: vi.fn(async () => {}) } }));
vi.mock("../lib/auth/withApiKey.js", () => ({
  withApiKey: async (req: { apiKeyUser?: unknown }) => {
    req.apiKeyUser = { id: "u1", workspaceId: "ws-1", role: "admin", approvalRequired: false, plan: "pro", planStatus: "active" };
  },
  canUseApi: () => true,
}));
vi.mock("../lib/mediaDelete.js", async () => {
  const real = await vi.importActual<typeof import("../lib/mediaDelete.js")>("../lib/mediaDelete.js");
  return {
    ...real,
    withUploads: async (urls: Iterable<string>, prepare: (tx: unknown) => unknown, fn: (db: unknown) => unknown) => {
      h.locked.push([...urls]);
      const tx = {
        $queryRaw: vi.fn(async () => h.missingCanvas ? [] : [
          { url: "/uploads/canvas-designs/s1/p.png", userId: "u1", claimedAt: new Date() },
          { url: "/uploads/old.png", userId: "u1", claimedAt: new Date() },
          { url: "/uploads/new.png", userId: "u1", claimedAt: new Date() },
        ]),
        upload: { updateMany: vi.fn(async () => ({ count: 1 })) },
        postJob: { update: vi.fn(async (args: { data: Record<string, any> }) => { h.updates.push(args); return { ...h.job, ...args.data }; }) },
      };
      await prepare(tx);
      return fn(tx);
    },
    releaseMedia: vi.fn(async (_storage: unknown, urls: Iterable<string>) => { h.released.push([...urls]); }),
  };
});

import { publicApiRoutes } from "./publicApi.js";
import { schedulePostJob } from "../lib/queue.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(publicApiRoutes, { storage: {} as StorageAdapter });
  await app.ready();
});
afterAll(async () => void (await app.close()));
beforeEach(() => {
  h.job = null;
  h.accounts = [];
  h.updates = [];
  h.created = [];
  h.released = [];
  h.locked = [];
  h.missingCanvas = false;
  h.targetDeletes.mockClear();
  h.targetCreates.mockClear();
  vi.mocked(schedulePostJob).mockClear();
});

const designContent = JSON.stringify({
  text: "Caption",
  mediaUrls: ["/uploads/canvas-designs/s1/p.png"],
  canvasDesigns: [{ submissionId: "s1", mediaUrl: "/uploads/canvas-designs/s1/p.png", bytes: 1200 }],
});
const job = (patch: Record<string, unknown> = {}) => ({
  id: "p1", workspaceId: "ws-1", userId: "u1", status: "pending", approvalStatus: null,
  scheduledFor: new Date("2030-01-01T00:00:00Z"), content: designContent, commentText: null,
  targets: [{ id: "t1", account: { platform: "linkedin" } }],
  ...patch,
});
const future = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

describe("public API T7 compatibility and provenance gates", () => {
  const canvasUrl = "/uploads/canvas-designs/s1/p.png";

  it("create refuses a Canvas-design URL because this writer cannot supply validated metadata", async () => {
    h.accounts = [{ id: "li", platform: "linkedin" }];
    const res = await app.inject({ method: "POST", url: "/api/v1/posts", payload: { content: "Caption", images: [canvasUrl], accountIds: ["li"], draft: true } });
    expect([res.statusCode, res.json().code]).toEqual([400, "DESIGN_METADATA_REQUIRED"]);
    expect(h.created).toHaveLength(0);
  });

  it("PATCH cannot introduce a Canvas-design URL without matching metadata", async () => {
    h.job = job({ content: JSON.stringify({ text: "Caption", mediaUrls: [] }) });
    const res = await app.inject({ method: "PATCH", url: "/api/v1/posts/p1", payload: { images: [canvasUrl] } });
    expect([res.statusCode, res.json().code]).toEqual([409, "DESIGN_METADATA_REQUIRED"]);
    expect(h.updates).toHaveLength(0);
  });

  it("replacing pictures releases the removed held files instead of leaving claimed orphans", async () => {
    const oldUrl = "/uploads/old.png";
    const newUrl = "/uploads/new.png";
    h.job = job({ content: JSON.stringify({ text: "Caption", mediaUrls: [oldUrl] }) });
    const res = await app.inject({ method: "PATCH", url: "/api/v1/posts/p1", payload: { images: [newUrl] } });
    expect(res.statusCode).toBe(200);
    expect(h.released).toEqual([[oldUrl]]);
  });

  it("PATCH retargeting to Instagram is refused before content, targets or queue are written", async () => {
    h.job = job();
    h.accounts = [{ id: "ig", platform: "instagram" }];
    const res = await app.inject({ method: "PATCH", url: "/api/v1/posts/p1", payload: { accountIds: ["ig"] } });
    expect([res.statusCode, res.json().code]).toEqual([409, "DESIGN_IMAGE_INCOMPATIBLE"]);
    expect(res.json().problems[0]).toMatch(/Instagram.*JPEG/);
    expect(h.updates).toHaveLength(0);
    expect(h.targetDeletes).not.toHaveBeenCalled();
    expect(h.targetCreates).not.toHaveBeenCalled();
    expect(schedulePostJob).not.toHaveBeenCalled();
  });

  it("a text-only PATCH still locks the final Canvas media before writing stale whole content", async () => {
    h.job = job();
    const res = await app.inject({ method: "PATCH", url: "/api/v1/posts/p1", payload: { content: "Edited" } });
    expect(res.statusCode).toBe(200);
    expect(h.locked).toEqual([[canvasUrl]]);
  });

  it("a text-only PATCH returns 409 and writes nothing when the final Canvas Upload row disappeared", async () => {
    h.job = job();
    h.missingCanvas = true;
    const res = await app.inject({ method: "PATCH", url: "/api/v1/posts/p1", payload: { content: "Stale" } });
    expect([res.statusCode, res.json().code]).toEqual([409, "MEDIA_UNAVAILABLE"]);
    expect(h.updates).toHaveLength(0);
  });

  it("PATCH content that leaves an Instagram target is refused before the content write", async () => {
    h.job = job({ targets: [{ id: "t1", account: { platform: "instagram" } }] });
    const res = await app.inject({ method: "PATCH", url: "/api/v1/posts/p1", payload: { content: "Edited" } });
    expect([res.statusCode, res.json().code]).toEqual([409, "DESIGN_IMAGE_INCOMPATIBLE"]);
    expect(h.updates).toHaveLength(0);
  });

  it("an invalid target change is refused before a simultaneous content edit is written", async () => {
    h.job = job();
    const res = await app.inject({ method: "PATCH", url: "/api/v1/posts/p1", payload: { content: "Edited", accountIds: ["missing"] } });
    expect(res.statusCode).toBe(400);
    expect(h.updates).toHaveLength(0);
  });

  it("approve refuses an Instagram draft before updating or queueing it", async () => {
    h.job = job({ status: "draft", designRequest: null, targets: [{ id: "t1", account: { platform: "instagram" } }] });
    const res = await app.inject({ method: "POST", url: "/api/v1/posts/p1/approve", payload: { scheduledFor: future() } });
    expect([res.statusCode, res.json().code]).toEqual([409, "DESIGN_IMAGE_INCOMPATIBLE"]);
    expect(h.updates).toHaveLength(0);
    expect(schedulePostJob).not.toHaveBeenCalled();
  });

  it("approve still schedules a compatible draft", async () => {
    h.job = job({ status: "draft", designRequest: null });
    const res = await app.inject({ method: "POST", url: "/api/v1/posts/p1/approve", payload: { scheduledFor: future() } });
    expect(res.statusCode).toBe(200);
    expect(h.updates).toHaveLength(1);
    expect(schedulePostJob).toHaveBeenCalledWith("p1", expect.any(Date));
  });
});
