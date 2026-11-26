// The Studio export on a compose draft (Path A): what it stores, who may store it, and what a re-save releases.
// Prisma is a small stateful fake; the Upload lock protocol runs on lib/fakeUploads.ts, and the atomic jsonb_set
// is applied to the fake content exactly as the real SQL would.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Post = { id: string; workspaceId: string; userId: string; status: string; approvalStatus: string | null; content: string };
type Instance = { id: string; workspaceId: string; kind: string; createdByUserId: string; version: number };

const h = vi.hoisted(() => ({
  userId: "u-me",
  workspace: "ws-1",
  role: "member",
  posts: new Map<string, Post>(),
  instances: new Map<string, Instance>(),
  uploads: null as null | ReturnType<typeof import("../lib/fakeUploads.js").fakeUploads>,
  deleted: [] as string[],
}));

vi.mock("../lib/prisma.js", () => {
  const tx = () => ({
    $queryRaw: async (...a: [TemplateStringsArray, ...unknown[]]) => h.uploads!.$queryRaw(...a),
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("jsonb_set")) {
        const post = h.posts.get(values[1] as string)!;
        const content = JSON.parse(post.content) as Record<string, unknown>;
        content.canvasExport = JSON.parse(values[0] as string);
        post.content = JSON.stringify(content);
        return 1;
      }
      if (sql.includes("- 'canvasExport'")) {
        const post = h.posts.get(values[0] as string)!;
        const content = JSON.parse(post.content) as Record<string, unknown>;
        delete content.canvasExport;
        post.content = JSON.stringify(content);
        return 1;
      }
      return 0; // the advisory lock
    },
    upload: {
      updateMany: (a: never) => h.uploads!.upload.updateMany(a),
      deleteMany: (a: never) => h.uploads!.upload.deleteMany(a),
    },
    template: { findMany: async () => [] },
    legacyTemplateMedia: { findMany: async () => [] },
  });
  return {
    prisma: {
      postJob: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; workspaceId: string } }) => {
          const p = h.posts.get(where.id);
          return p && p.workspaceId === where.workspaceId ? { ...p } : null;
        }),
      },
      design: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; workspaceId: string; kind: string; createdByUserId: string } }) => {
          const i = h.instances.get(where.id);
          return i && i.workspaceId === where.workspaceId && i.kind === where.kind && i.createdByUserId === where.createdByUserId
            ? { version: i.version }
            : null;
        }),
      },
      $transaction: async (fn: (t: unknown) => unknown) => fn(tx()),
    },
  };
});

vi.mock("../lib/auth/withAuth.js", async () => {
  const real = await vi.importActual<typeof import("../lib/auth/withAuth.js")>("../lib/auth/withAuth.js");
  return {
    ...real,
    withAuth: async () => {},
    getUser: () => ({ id: h.userId }),
    getWorkspaceId: () => h.workspace,
    getWorkspaceRole: async () => h.role,
  };
});

import { designExportRoutes } from "./designExport.js";
import { fakeUploads } from "../lib/fakeUploads.js";

const INSTANCE = "ckaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_INSTANCE = "ckbbbbbbbbbbbbbbbbbbbbbbb";

const storage = {
  delete: vi.fn(async (url: string) => {
    h.deleted.push(url);
    h.uploads!.rows.delete(url);
  }),
};

const upload = (url: string, owner = "u-me") => h.uploads!.rows.set(url, { url, userId: owner, claimedAt: null });
const post = (patch: Partial<Post> = {}) => {
  const p: Post = {
    id: "p1",
    workspaceId: "ws-1",
    userId: "u-me",
    status: "draft",
    approvalStatus: null,
    content: JSON.stringify({ text: "Caption", mediaUrls: [] }),
    ...patch,
  };
  h.posts.set(p.id, p);
  return p;
};
const contentOf = (id = "p1") => JSON.parse(h.posts.get(id)!.content) as { canvasExport?: { instanceId: string; version: number; files: Array<{ format: string; mediaUrl: string }> } };

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(designExportRoutes, { storage } as never);
  await app.ready();
});
afterAll(async () => void (await app.close()));

beforeEach(() => {
  h.userId = "u-me";
  h.workspace = "ws-1";
  h.role = "member";
  h.posts.clear();
  h.instances.clear();
  h.deleted = [];
  storage.delete.mockClear();
  h.uploads = fakeUploads([], () => [...h.uploads!.rows.keys()].filter((u) => [...h.posts.values()].some((p) => p.content.includes(u))));
  h.instances.set(INSTANCE, { id: INSTANCE, workspaceId: "ws-1", kind: "instance", createdByUserId: "u-me", version: 3 });
});

const attach = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/jobs/p1/design-export", payload: body });
const remove = () => app.inject({ method: "DELETE", url: "/jobs/p1/design-export" });
const bodyOf = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;
const files = (patch: Array<{ format: string; mediaUrl: string }> = [{ format: "pdf", mediaUrl: "/uploads/a.pdf" }]) => ({ instanceId: INSTANCE, version: 3, files: patch });

describe("POST /jobs/:id/design-export", () => {
  it("stores the export in one content key, claims the files and answers with it", async () => {
    post();
    upload("/uploads/a.pdf");
    upload("/uploads/a.jpg");
    const res = await attach(files([{ format: "pdf", mediaUrl: "/uploads/a.pdf" }, { format: "jpeg", mediaUrl: "/uploads/a.jpg" }]));
    expect(res.statusCode).toBe(201);
    expect(contentOf().canvasExport).toEqual({
      instanceId: INSTANCE,
      version: 3,
      files: [{ format: "pdf", mediaUrl: "/uploads/a.pdf" }, { format: "jpeg", mediaUrl: "/uploads/a.jpg" }],
    });
    expect(h.uploads!.rows.get("/uploads/a.pdf")!.claimedAt).not.toBeNull();
    expect(h.uploads!.rows.get("/uploads/a.jpg")!.claimedAt).not.toBeNull();
  });

  it("never touches the rest of the draft content", async () => {
    post({ content: JSON.stringify({ text: "Keep me", title: "T", mediaUrls: ["/uploads/old.png"] }) });
    upload("/uploads/a.png");
    expect((await attach(files([{ format: "png", mediaUrl: "/uploads/a.png" }]))).statusCode).toBe(201);
    expect(contentOf()).toMatchObject({ text: "Keep me", title: "T", mediaUrls: ["/uploads/old.png"] });
  });

  it("is for a plain draft only: a scheduled post and one in review are refused, and nothing is stored", async () => {
    h.role = "admin"; // an admin may edit a scheduled post, so the route's own draft gate is what refuses it
    post({ status: "pending" });
    expect((await attach(files())).statusCode).toBe(409);
    h.role = "member";
    post({ status: "draft", approvalStatus: "pending" });
    const res = await attach(files());
    expect(res.statusCode).toBe(409);
    expect(bodyOf(res).code).toBe("NOT_A_DRAFT");
    expect(contentOf().canvasExport).toBeUndefined();
  });

  it("refuses a designer (not a content editor)", async () => {
    h.role = "designer";
    post();
    expect((await attach(files())).statusCode).toBe(403);
  });

  it("refuses another person's instance, another workspace's, and a design that is not an instance", async () => {
    post();
    h.instances.set(INSTANCE, { id: INSTANCE, workspaceId: "ws-1", kind: "instance", createdByUserId: "u-other", version: 3 });
    expect((await attach(files())).statusCode).toBe(404);
    h.instances.set(INSTANCE, { id: INSTANCE, workspaceId: "ws-2", kind: "instance", createdByUserId: "u-me", version: 3 });
    expect((await attach(files())).statusCode).toBe(404);
    h.instances.set(INSTANCE, { id: INSTANCE, workspaceId: "ws-1", kind: "template", createdByUserId: "u-me", version: 3 });
    expect((await attach(files())).statusCode).toBe(404);
  });

  it("refuses an export made from a version the design no longer has", async () => {
    post();
    h.instances.set(INSTANCE, { id: INSTANCE, workspaceId: "ws-1", kind: "instance", createdByUserId: "u-me", version: 4 });
    const res = await attach(files());
    expect(res.statusCode).toBe(409);
    expect(bodyOf(res).code).toBe("VERSION_CONFLICT");
  });

  it("refuses a file that is not the caller's own upload, and a file with the wrong extension", async () => {
    post();
    upload("/uploads/a.pdf", "u-other");
    expect((await attach(files())).statusCode).toBe(409);
    upload("/uploads/a.png");
    const wrong = await attach(files([{ format: "pdf", mediaUrl: "/uploads/a.png" }]));
    expect(wrong.statusCode).toBe(400);
    expect(bodyOf(wrong).code).toBe("INVALID_DESIGN_EXPORT");
    // the regression this slice fixed: a PNG export re-encoded to .jpg must never be attached as a PNG
    upload("/uploads/a.jpg");
    const reencoded = await attach(files([{ format: "png", mediaUrl: "/uploads/a.jpg" }]));
    expect(reencoded.statusCode).toBe(400);
    expect(bodyOf(reencoded).code).toBe("INVALID_DESIGN_EXPORT");
  });

  it("a re-save replaces the previous export and releases the old file", async () => {
    post({ content: JSON.stringify({ text: "x", canvasExport: { instanceId: OTHER_INSTANCE, version: 2, files: [{ format: "pdf", mediaUrl: "/uploads/old.pdf" }] } }) });
    upload("/uploads/old.pdf");
    upload("/uploads/new.pdf");
    expect((await attach(files([{ format: "pdf", mediaUrl: "/uploads/new.pdf" }]))).statusCode).toBe(201);
    expect(contentOf().canvasExport!.files).toEqual([{ format: "pdf", mediaUrl: "/uploads/new.pdf" }]);
    expect(h.deleted).toContain("/uploads/old.pdf");
    expect(h.deleted).not.toContain("/uploads/new.pdf");
  });
});

describe("DELETE /jobs/:id/design-export", () => {
  it("removes the export, leaves the rest of the content and releases the file", async () => {
    post({ content: JSON.stringify({ text: "Keep", canvasExport: { instanceId: INSTANCE, version: 3, files: [{ format: "pdf", mediaUrl: "/uploads/old.pdf" }] } }) });
    upload("/uploads/old.pdf");
    const res = await remove();
    expect(res.statusCode).toBe(200);
    expect(contentOf()).toEqual({ text: "Keep" });
    expect(h.deleted).toContain("/uploads/old.pdf");
  });

  it("is refused for a post that is no longer a plain draft", async () => {
    h.role = "admin"; // an admin may edit a scheduled post, so the route's own draft gate is what refuses it
    post({ status: "pending" });
    expect((await remove()).statusCode).toBe(409);
  });
});
