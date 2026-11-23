// What deleting a post, many posts, or an upload does to the FILES. The point: a file that something else still uses survives, whoever
// deletes; and nothing but an Upload row of an allowed owner ever reaches storage.delete. The Upload table and the posts are stateful
// fakes, so "the other post still holds it" is real state, not a stubbed answer.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  uploads: null as null | ReturnType<typeof import("../lib/fakeUploads.js").fakeUploads>,
  posts: new Map<string, { id: string; content: string; userId: string; status: string; workspaceId: string }>(),
  items: [] as string[], // urls held by Library items / templates (anything that is not a post)
  role: "member",
  viewer: "u-author",
}));

vi.mock("../lib/prisma.js", () => {
  const tx = () => ({
    $queryRaw: (...a: [TemplateStringsArray, ...unknown[]]) => h.uploads!.$queryRaw(...a),
    upload: { updateMany: (a: never) => h.uploads!.upload.updateMany(a), deleteMany: (a: never) => h.uploads!.upload.deleteMany(a) },
    template: { findMany: async () => [] },
    legacyTemplateMedia: { findMany: async () => [] },
  });
  return {
    prisma: {
      postJob: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; workspaceId: string } }) => {
          const p = h.posts.get(where.id);
          return p && p.workspaceId === where.workspaceId ? p : null;
        }),
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.flatMap((id) => (h.posts.has(id) ? [h.posts.get(id)!] : []))),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => void h.posts.delete(where.id)),
        deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.filter((id) => h.posts.delete(id)).length })),
      },
      upload: { findFirst: vi.fn(async ({ where }: { where: { url: string; userId: string } }) => { const r = h.uploads!.rows.get(where.url); return r && r.userId === where.userId ? r : null; }) },
      $transaction: async (fn: (t: unknown) => unknown) => fn(tx()),
    },
  };
});
vi.mock("../lib/auth/withAuth.js", async () => {
  const real = await vi.importActual<typeof import("../lib/auth/withAuth.js")>("../lib/auth/withAuth.js");
  return { ...real, withAuth: async () => {}, getUser: () => ({ id: h.viewer }), getWorkspaceId: () => "ws-1", getWorkspaceRole: async () => h.role };
});
vi.mock("../lib/queue.js", () => ({ schedulePostJob: vi.fn(), postJobQueue: { remove: vi.fn(async () => {}) } }));
vi.mock("../lib/enforcePlan.js", () => ({ enforcePlan: async () => null }));
vi.mock("../lib/auth/index.js", () => ({ authProvider: {} }));
vi.mock("../adapters/index.js", () => ({ adapters: [] }));
vi.mock("../lib/compress.js", () => ({ compressForPlatform: vi.fn() }));

import { jobRoutes } from "./jobs.js";
import { uploadRoutes } from "./upload.js";
import { fakeUploads } from "../lib/fakeUploads.js";

const storage = { upload: vi.fn(), delete: vi.fn(async () => {}), listFolder: vi.fn(), ownsUrl: () => true };
const ID = (n: number) => `c${String(n).padStart(24, "0")}`; // a cuid-shaped id (the bulk route validates the shape)

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(jobRoutes, { storage } as never);
  await app.register(uploadRoutes, { storage } as never);
  await app.ready();
});
afterAll(async () => void (await app.close()));

const post = (n: number, urls: string[], userId = "u-author", status = "draft") =>
  void h.posts.set(ID(n), { id: ID(n), content: JSON.stringify({ text: "x", mediaUrls: urls }), userId, status, workspaceId: "ws-1" });

beforeEach(() => {
  h.posts.clear();
  h.items = [];
  h.role = "member";
  h.viewer = "u-author";
  h.uploads = fakeUploads(
    [
      { url: "/uploads/a.png", userId: "u-author", claimedAt: new Date() },
      { url: "/uploads/b.png", userId: "u-author", claimedAt: new Date() },
      { url: "/uploads/theirs.png", userId: "someone-else", claimedAt: new Date() },
    ],
    () => [...[...h.posts.values()].flatMap((p) => JSON.parse(p.content).mediaUrls as string[]), ...h.items],
  );
  storage.delete.mockClear();
});

const del = (n: number) => app.inject({ method: "DELETE", url: `/jobs/${ID(n)}` });
const bulk = (ns: number[]) => app.inject({ method: "DELETE", url: "/jobs/bulk", payload: { ids: ns.map(ID) } });
const rm = (url: unknown) => app.inject({ method: "DELETE", url: "/upload", payload: { url } });
const removed = () => storage.delete.mock.calls.map((c) => (c as unknown as string[])[0]).sort();

describe("DELETE /jobs/:id", () => {
  it("deletes the author's file when nothing else uses it", async () => {
    post(1, ["/uploads/a.png"]);
    expect((await del(1)).statusCode).toBe(204);
    expect(removed()).toEqual(["/uploads/a.png"]);
    expect(h.uploads!.rows.has("/uploads/a.png")).toBe(false);
  });

  it("KEEPS a file another post still uses (a duplicate, a repeat), and removes it with the last one", async () => {
    post(1, ["/uploads/a.png"]);
    post(2, ["/uploads/a.png"]); // the copy
    await del(1);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(h.uploads!.rows.has("/uploads/a.png")).toBe(true);
    await del(2);
    expect(removed()).toEqual(["/uploads/a.png"]);
  });

  it("keeps a file a PUBLISHED, SCHEDULED or FAILED post, a Library item or a template still uses", async () => {
    for (const status of ["done", "pending", "failed", "running"]) {
      h.posts.clear();
      h.uploads!.rows.set("/uploads/a.png", { url: "/uploads/a.png", userId: "u-author", claimedAt: new Date() });
      post(1, ["/uploads/a.png"]);
      post(2, ["/uploads/a.png"], "u-author", status);
      await del(1);
      expect(storage.delete, status).not.toHaveBeenCalled();
    }
    h.posts.clear();
    h.items = ["/uploads/a.png"]; // a Library item / template holds it
    post(1, ["/uploads/a.png"]);
    await del(1);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("an owner or admin deleting a member's post removes the AUTHOR's file, never one that is somebody else's", async () => {
    h.role = "admin";
    h.viewer = "u-admin";
    post(1, ["/uploads/a.png", "/uploads/theirs.png", "/uploads/norow.png"], "u-author");
    expect((await del(1)).statusCode).toBe(204);
    expect(removed()).toEqual(["/uploads/a.png"]); // theirs.png belongs to a third person; norow.png has no Upload row
  });

  it("a url with no Upload row, or a hostile one in stored content, never reaches storage.delete", async () => {
    post(1, ["/uploads/../../etc/passwd", "../x", "/etc/passwd", "https://example.com/a.png", "/uploads/norow.png"]);
    expect((await del(1)).statusCode).toBe(204);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("a member cannot delete a colleague's post, so its files are untouched", async () => {
    h.viewer = "u-other";
    post(1, ["/uploads/a.png"], "u-author");
    expect((await del(1)).statusCode).toBe(403);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(h.posts.has(ID(1))).toBe(true);
  });

  it("another workspace's post is a 404 and nothing is touched", async () => {
    h.posts.set(ID(9), { id: ID(9), content: JSON.stringify({ mediaUrls: ["/uploads/a.png"] }), userId: "u-author", status: "draft", workspaceId: "ws-2" });
    expect((await del(9)).statusCode).toBe(404);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

describe("DELETE /jobs/bulk", () => {
  it("two posts sharing a file: it stays while either is left, and goes only when both are gone", async () => {
    post(1, ["/uploads/a.png", "/uploads/b.png"]);
    post(2, ["/uploads/a.png"]);
    post(3, ["/uploads/b.png"]);
    await bulk([1, 2]); // 3 still holds b.png
    expect(removed()).toEqual(["/uploads/a.png"]);
    expect(h.uploads!.rows.has("/uploads/b.png")).toBe(true);
    storage.delete.mockClear();
    await bulk([3]);
    expect(removed()).toEqual(["/uploads/b.png"]);
  });

  it("deleting every post that shares a file in one request removes it once", async () => {
    post(1, ["/uploads/a.png"]);
    post(2, ["/uploads/a.png"]);
    expect(((await bulk([1, 2])).json() as { deleted: number }).deleted).toBe(2);
    expect(removed()).toEqual(["/uploads/a.png"]);
  });

  it("a member's bulk request skips a colleague's posts and their files", async () => {
    post(1, ["/uploads/a.png"], "u-author");
    post(2, ["/uploads/theirs.png"], "someone-else");
    await bulk([1, 2]);
    expect(removed()).toEqual(["/uploads/a.png"]);
    expect(h.posts.has(ID(2))).toBe(true);
  });
});

describe("DELETE /upload", () => {
  it("removes the person's own unused upload", async () => {
    expect((await rm("/uploads/a.png")).statusCode).toBe(204);
    expect(removed()).toEqual(["/uploads/a.png"]);
  });

  it("KEEPS an upload a saved draft uses: compose calls this when the person removes the picture or leaves the page", async () => {
    post(1, ["/uploads/a.png"]);
    expect((await rm("/uploads/a.png")).statusCode).toBe(204);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(h.uploads!.rows.has("/uploads/a.png")).toBe(true);
  });

  it("another person's upload is a 404 and is never removed", async () => {
    expect((await rm("/uploads/theirs.png")).statusCode).toBe(404);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(h.uploads!.rows.has("/uploads/theirs.png")).toBe(true);
  });

  it("a url with no row, a hostile url, a missing or non string url never reaches storage", async () => {
    for (const url of ["/uploads/norow.png", "/uploads/../../etc/passwd", "../x", "/etc/passwd", "https://example.com/a.png"]) {
      expect((await rm(url)).statusCode, url).toBe(404);
    }
    expect((await rm(undefined)).statusCode).toBe(400);
    expect((await rm(42)).statusCode).toBe(400);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

describe("POST and PATCH /jobs: an address that is not a usable string list", () => {
  it("a 2100 character address is a 400 on PATCH and the post's files are NOT released", async () => {
    post(1, ["/uploads/a.png"]);
    const res = await app.inject({ method: "PATCH", url: `/jobs/${ID(1)}`, payload: { mediaUrls: ["/uploads/" + "a".repeat(2100)] } });
    expect(res.statusCode).toBe(400);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(h.uploads!.rows.has("/uploads/a.png")).toBe(true);
  });
});
