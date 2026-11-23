// A post made through the public API or the MCP server may attach only files the key's owner uploaded and that still exist, and claims
// them in the same transaction as the post. Anything else is refused and nothing is stored.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  uploads: null as null | ReturnType<typeof import("../lib/fakeUploads.js").fakeUploads>,
  created: [] as Array<Record<string, any>>,
}));

vi.mock("../lib/prisma.js", () => {
  const tx = () => ({
    $queryRaw: (...a: [TemplateStringsArray, ...unknown[]]) => h.uploads!.$queryRaw(...a),
    upload: { updateMany: (a: never) => h.uploads!.upload.updateMany(a) },
    postJob: {
      create: async (args: { data: Record<string, any> }) => {
        h.created.push(args.data);
        return { id: "new", status: args.data.status, scheduledFor: new Date(0), dryRun: false, targets: [] };
      },
    },
  });
  return {
    prisma: {
      account: { findMany: vi.fn(async () => [{ id: "acc-1" }]) },
      postJob: tx().postJob,
      $transaction: async (fn: (t: unknown) => unknown) => fn(tx()),
    },
  };
});
vi.mock("../lib/queue.js", () => ({ schedulePostJob: vi.fn(async () => {}), postJobQueue: {} }));
vi.mock("../lib/auth/withApiKey.js", () => ({
  withApiKey: async (req: { apiKeyUser?: unknown }) => {
    req.apiKeyUser = { id: "key-owner", workspaceId: "ws-1", role: "admin", approvalRequired: false, plan: "pro", planStatus: "active" };
  },
  canUseApi: () => true,
}));

import { publicApiRoutes } from "./publicApi.js";
import { handleTool } from "./mcp.js";
import { fakeUploads } from "../lib/fakeUploads.js";
import type { StorageAdapter } from "../lib/storage.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(publicApiRoutes, { storage: {} as StorageAdapter });
  await app.ready();
});
afterAll(async () => void (await app.close()));
beforeEach(() => {
  h.created = [];
  h.uploads = fakeUploads([
    { url: "/uploads/mine.png", userId: "key-owner", claimedAt: null },
    { url: "/uploads/theirs.png", userId: "someone-else", claimedAt: null },
  ]);
});

const api = (images: unknown) => app.inject({ method: "POST", url: "/api/v1/posts", payload: { content: "Caption", accountIds: ["acc-1"], draft: true, images } });
const mcp = (media_urls: unknown) =>
  handleTool("create_post", { content: "Caption", account_ids: ["acc-1"], media_urls }, "key-owner", "ws-1", { role: "admin", approvalRequired: false });

describe("POST /api/v1/posts: images", () => {
  it("attaches the key owner's own upload and CLAIMS it, so the 24 h cleaner leaves it alone", async () => {
    expect((await api(["/uploads/mine.png"])).statusCode).toBe(201);
    expect(JSON.parse(h.created[0].content).mediaUrls).toEqual(["/uploads/mine.png"]);
    expect(h.uploads!.rows.get("/uploads/mine.png")!.claimedAt).toBeInstanceOf(Date);
  });

  it("the API's own address in front of the upload is accepted and stored as the path", async () => {
    process.env.PUBLIC_API_URL = "https://api.example.test";
    try {
      expect((await api(["https://api.example.test/uploads/mine.png"])).statusCode).toBe(201);
      expect(JSON.parse(h.created[0].content).mediaUrls).toEqual(["/uploads/mine.png"]);
    } finally {
      delete process.env.PUBLIC_API_URL;
    }
  });

  it("another workspace member's upload, a removed one, and a path with no row are a 409 and nothing is stored", async () => {
    for (const bad of ["/uploads/theirs.png", "/uploads/gone.png"]) {
      const res = await api([bad]);
      expect(res.statusCode, bad).toBe(409);
      expect(res.json()).toMatchObject({ code: "MEDIA_UNAVAILABLE" });
    }
    expect(h.created).toHaveLength(0);
    expect(h.uploads!.rows.get("/uploads/theirs.png")!.claimedAt).toBeNull();
  });

  it("hostile or outside addresses are a 400: traversal, other schemes, a private address, any external image", async () => {
    for (const bad of ["/uploads/../../etc/passwd", "../x", "file:///etc/passwd", "javascript:alert(1)", "http://169.254.169.254/latest/meta-data", "http://localhost/a.png", "https://example.com/a.png"]) {
      const res = await api([bad]);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_MEDIA_URL" });
    }
    expect(h.created).toHaveLength(0);
  });

  it("not an array, too many, or not strings: 400 and nothing stored", async () => {
    for (const bad of ["x", { a: 1 }, Array(11).fill("/uploads/mine.png"), [1], [null]]) expect((await api(bad)).statusCode).toBe(400);
    expect(h.created).toHaveLength(0);
  });

  it("the lock is taken before the post is written", async () => {
    await api(["/uploads/mine.png"]);
    expect(h.uploads!.log.map((l) => l.fn)).toEqual(["lock", "updateMany"]);
  });
});

describe("MCP create_post: media_urls", () => {
  it("attaches the owner's own upload and claims it", async () => {
    await mcp(["/uploads/mine.png"]);
    expect(JSON.parse(h.created[0].content).mediaUrls).toEqual(["/uploads/mine.png"]);
    expect(h.uploads!.rows.get("/uploads/mine.png")!.claimedAt).toBeInstanceOf(Date);
  });

  it("another person's upload, a removed one, a hostile address and an external one are refused and nothing is stored", async () => {
    for (const bad of ["/uploads/theirs.png", "/uploads/gone.png", "/uploads/../../etc/passwd", "file:///etc/passwd", "http://169.254.169.254/x", "https://example.com/a.png"]) {
      await expect(mcp([bad]), bad).rejects.toBeTruthy();
    }
    expect(h.created).toHaveLength(0);
    expect(h.uploads!.rows.get("/uploads/theirs.png")!.claimedAt).toBeNull();
  });

  it("not an array or more than 10 is refused", async () => {
    await expect(mcp("x")).rejects.toThrow(/media_urls/);
    await expect(mcp(Array(11).fill("/uploads/mine.png"))).rejects.toThrow(/media_urls/);
  });
});
