// The Template Library routes: who sees a draft, that a new template starts as a draft, and who may publish. The
// routes run against a fake database that keeps the where of every query, so a test can prove the filter is asked for.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../lib/storage.js";

const h = vi.hoisted(() => ({
  role: "designer" as string | null,
  rows: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ fn: string; args: Record<string, any> }>,
  taken: false,
}));

const FORBIDDEN = { error: "Templates are managed by the design team only.", code: "FORBIDDEN" };

vi.mock("../lib/prisma.js", () => {
  const record = (fn: string, result: (args: Record<string, any>) => unknown) =>
    vi.fn(async (args: Record<string, any>) => {
      h.calls.push({ fn, args });
      return result(args);
    });
  return {
    prisma: {
      template: {
        findMany: record("findMany", () => h.rows),
        findFirst: record("findFirst", (args) => (args.where.category && h.taken ? { id: "other" } : h.rows[0] ?? null)),
        create: record("create", (args) => ({ id: "t-new", published: false, user: { name: "Dewi Kusuma" }, createdAt: new Date("2026-11-12T03:00:00Z"), updatedAt: new Date("2026-11-12T03:00:00Z"), name: args.data.category, pillar: args.data.pillar, category: args.data.category, linkUrl: args.data.linkUrl, previewUrl: args.data.previewUrl, format: args.data.format, slides: args.data.slides, platforms: args.data.platforms })),
        update: record("update", () => h.rows[0]),
        updateMany: record("updateMany", (args) => ({ count: args.where.workspaceId === "ws-1" && h.rows.length ? 1 : 0 })),
        delete: record("delete", () => ({})),
      },
      upload: { count: vi.fn(async () => 0), updateMany: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({})) },
      legacyTemplateMedia: { findMany: vi.fn(async () => []) },
    },
  };
});
vi.mock("../lib/auth/withAuth.js", () => ({
  withAuth: async () => {},
  withAuthOrToken: async () => {},
  getUser: () => ({ id: "dewi" }),
  getWorkspaceId: () => "ws-1",
  getWorkspaceRole: async () => h.role,
  requireTemplateManagerRole: async () => (h.role === "designer" ? null : FORBIDDEN),
}));

import { templateRoutes } from "./templates.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(templateRoutes, { storage: {} as StorageAdapter });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  h.role = "designer";
  h.rows = [];
  h.calls = [];
  h.taken = false;
});

const call = (fn: string) => h.calls.filter((c) => c.fn === fn);
const row = (patch: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "Case Study",
  pillar: "Promotional",
  category: "Case Study",
  linkUrl: "https://www.figma.com/design/AbC/Case",
  previewUrl: null,
  published: true,
  format: "carousel",
  slides: 5,
  platforms: ["linkedin", "instagram"],
  createdAt: new Date("2026-11-12T03:00:00Z"),
  updatedAt: new Date("2026-11-12T03:00:00Z"),
  user: { name: "Dewi Kusuma" },
  ...patch,
});
const body = (patch: Record<string, unknown> = {}) => ({
  pillar: "Promotional",
  category: "Case Study",
  linkUrl: "https://www.figma.com/design/AbC/Case",
  ...patch,
});

describe("template routes", () => {
  it("no longer has the .fig upload endpoint", async () => {
    expect(app.hasRoute({ method: "POST", url: "/templates/file" })).toBe(false);
    expect(app.hasRoute({ method: "POST", url: "/templates" })).toBe(true);
    expect((await app.inject({ method: "POST", url: "/templates/file" })).statusCode).toBe(404);
  });
});

describe("GET /templates: who sees a draft", () => {
  it("the design team asks for every template, drafts included", async () => {
    h.rows = [row({ published: false })];
    expect((await app.inject({ method: "GET", url: "/templates" })).statusCode).toBe(200);
    expect(call("findMany")[0].args.where).toEqual({ workspaceId: "ws-1", category: { not: null } });
  });

  it.each(["owner", "admin", "member", null])("a %s asks for the published ones only", async (role) => {
    h.role = role as string | null;
    await app.inject({ method: "GET", url: "/templates" });
    expect(call("findMany")[0].args.where).toMatchObject({ workspaceId: "ws-1", published: true });
  });

  it("a row carries the status, format, platforms and who made it; the user record does not leave", async () => {
    h.rows = [row()];
    const res = await app.inject({ method: "GET", url: "/templates" });
    const [t] = res.json().templates;
    expect(t).toMatchObject({ id: "t1", published: true, format: "carousel", slides: 5, platforms: ["linkedin", "instagram"], createdBy: "Dewi Kusuma" });
    expect(t).not.toHaveProperty("user");
  });
});

describe("POST /templates: a new template starts as a draft", () => {
  it("is created without `published`, so the column default (draft) applies, even when the body asks for it", async () => {
    const res = await app.inject({ method: "POST", url: "/templates", payload: body({ published: true }) });
    expect(res.statusCode).toBe(201);
    expect(call("create")[0].args.data).not.toHaveProperty("published");
    expect(res.json().template.published).toBe(false);
  });

  it("keeps the format, the slides of a carousel and the platforms", async () => {
    await app.inject({ method: "POST", url: "/templates", payload: body({ format: "carousel", slides: 5, platforms: ["instagram", "instagram", "linkedin"] }) });
    expect(call("create")[0].args.data).toMatchObject({ format: "carousel", slides: 5, platforms: ["instagram", "linkedin"] });
  });

  it("a member may not: 403, nothing is written", async () => {
    h.role = "member";
    const res = await app.inject({ method: "POST", url: "/templates", payload: body() });
    expect(res.statusCode).toBe(403);
    expect(call("create")).toHaveLength(0);
  });

  it("a second template for the same category is a 409", async () => {
    h.taken = true;
    expect((await app.inject({ method: "POST", url: "/templates", payload: body() })).statusCode).toBe(409);
  });
});

describe("PATCH /templates/:id: an edit does not change the status", () => {
  it("the edit data has no `published`, even when the body has it", async () => {
    h.rows = [row({ published: true })];
    const res = await app.inject({ method: "PATCH", url: "/templates/t1", payload: body({ published: false }) });
    expect(res.statusCode).toBe(200);
    expect(call("update")[0].args.data).not.toHaveProperty("published");
  });
});

describe("PATCH /templates/:id/status: publish and unpublish", () => {
  const set = (published: unknown, id = "t1") => app.inject({ method: "PATCH", url: `/templates/${id}/status`, payload: { published } });

  it("the design team publishes, and the where holds the workspace", async () => {
    h.rows = [row({ published: true })];
    const res = await set(true);
    expect(res.statusCode).toBe(200);
    expect(call("updateMany")[0].args).toEqual({ where: { id: "t1", workspaceId: "ws-1" }, data: { published: true } });
    expect(res.json().template).toMatchObject({ id: "t1", published: true });
  });

  it("and takes it back to a draft", async () => {
    h.rows = [row({ published: false })];
    await set(false);
    expect(call("updateMany")[0].args.data).toEqual({ published: false });
  });

  it.each(["owner", "admin", "member", null])("a %s may not: 403, nothing is written", async (role) => {
    h.role = role as string | null;
    const res = await set(true);
    expect(res.statusCode).toBe(403);
    expect(call("updateMany")).toHaveLength(0);
  });

  it("a template of another workspace (or none) is a 404", async () => {
    h.rows = [];
    expect((await set(true, "elsewhere")).statusCode).toBe(404);
  });

  it("a body that is not true or false is a 400", async () => {
    h.rows = [row()];
    expect((await set("yes")).statusCode).toBe(400);
    expect(call("updateMany")).toHaveLength(0);
  });
});
