// GET /dashboard/design: the design team's dashboard. These tests drive the route with a fake database and check
// who may call it, which rows each query asks for, and that nothing but data leaves (never the content JSON).
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "designer" as string | null,
  userId: "dewi",
  calls: [] as Array<{ model: string; fn: string; args: unknown }>,
  groups: [] as Array<{ approvalStatus: string | null; _count: number }>,
  approved: 0,
  queue: [] as unknown[],
  submitted: [] as unknown[],
  reviewed: [] as unknown[],
  templates: [] as unknown[],
}));

vi.mock("../lib/prisma.js", () => {
  const record = (model: string, fn: string, result: (args: unknown) => unknown) =>
    vi.fn(async (args: unknown) => {
      h.calls.push({ model, fn, args });
      return result(args);
    });
  return {
    prisma: {
      postJob: {
        groupBy: record("postJob", "groupBy", () => h.groups),
        count: record("postJob", "count", () => h.approved),
        findMany: record("postJob", "findMany", (args) => {
          const json = JSON.stringify(args);
          if (json.includes('"submitCount":true')) return h.queue;
          if (json.includes('"submittedAt":{"gte"')) return h.submitted;
          return h.reviewed;
        }),
      },
      template: { findMany: record("template", "findMany", () => h.templates) },
    },
  };
});
vi.mock("../lib/auth/withAuth.js", () => ({
  withAuth: async () => {},
  getUser: () => ({ id: h.userId }),
  getWorkspaceId: () => "ws-1",
  requireManageRole: async () =>
    h.role === "owner" || h.role === "admin" || h.role === "designer" ? null : { error: "Only workspace admins or designers can perform this action.", code: "FORBIDDEN" },
  // the Posts page rule, so a test can prove this route does not use it
  jobVisibilityWhere: () => ({ OR: [{ status: { not: "draft" } }, { approvalStatus: "pending" }] }),
  getWorkspaceRole: async () => h.role,
}));

import { dashboardRoutes } from "./dashboard.js";

let app: FastifyInstance;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T05:00:00Z")); // 12:00 WIB on Tue 17 Nov 2026, in Q4
  app = Fastify();
  await app.register(dashboardRoutes);
  await app.ready();
});
afterAll(async () => {
  vi.useRealTimers();
  await app.close();
});
beforeEach(() => {
  h.role = "designer";
  h.calls = [];
  h.groups = [];
  h.approved = 0;
  h.queue = [];
  h.submitted = [];
  h.reviewed = [];
  h.templates = [];
});

const get = () => app.inject({ method: "GET", url: "/dashboard/design" });
const call = (model: string, fn: string) => h.calls.filter((c) => c.model === model && c.fn === fn);
const argsOf = (c: { args: unknown }) => c.args as Record<string, any>;

const queued = (patch: Record<string, unknown> = {}) => ({
  id: "p1",
  status: "draft",
  approvalStatus: "pending",
  scheduledFor: new Date("2026-11-20T02:00:00Z"),
  content: JSON.stringify({ title: "Backcasting 2026", mediaUrls: ["/uploads/a.png", "/uploads/b.png"], category: "Case Study", designCopy: "a long secret paragraph" }),
  submittedAt: new Date("2026-11-14T02:00:00Z"),
  submitCount: 2,
  submittedBy: { name: "Dewi K." },
  user: { name: "Putri A." },
  ...patch,
});

describe("GET /dashboard/design: who may call it", () => {
  it.each(["designer", "admin", "owner"])("a %s may", async (role) => {
    h.role = role;
    expect((await get()).statusCode).toBe(200);
  });

  it.each(["member", null])("a %s may not: 403, and nothing is read", async (role) => {
    h.role = role as string | null;
    const res = await get();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("GET /dashboard/design: the numbers", () => {
  it("pending and revision come from one count of the workspace's drafts in review, and the approved count is the quarter's", async () => {
    h.groups = [{ approvalStatus: "pending", _count: 8 }, { approvalStatus: "rejected", _count: 3 }];
    h.approved = 46;
    expect(await get().then((r) => r.json())).toMatchObject({ pending: 8, revision: 3, approved: 46 });
  });

  it("a workspace with nothing in review has zeros, not holes", async () => {
    h.groups = [{ approvalStatus: "pending", _count: 2 }];
    expect(await get().then((r) => r.json())).toMatchObject({ pending: 2, revision: 0, approved: 0 });
  });

  it("revision counts the drafts sent back WITHOUT the Posts page's visibility rule, which hides them from a designer", async () => {
    await get();
    const where = argsOf(call("postJob", "groupBy")[0]).where;
    expect(where).toEqual({ workspaceId: "ws-1", status: "draft", approvalStatus: { in: ["pending", "rejected"] } });
    expect(JSON.stringify(h.calls)).not.toContain('"OR"');
  });

  it("approved counts the posts approved in this WIB quarter, by anyone: Q4 runs from 30 Sep 17:00 UTC to 31 Dec 17:00 UTC", async () => {
    await get();
    expect(argsOf(call("postJob", "count")[0]).where).toEqual({
      workspaceId: "ws-1",
      approvalStatus: "approved",
      reviewedAt: { gte: new Date("2026-09-30T17:00:00Z"), lt: new Date("2026-12-31T17:00:00Z") },
    });
  });
});

describe("GET /dashboard/design: the queue", () => {
  it("asks for the five drafts in review that have waited longest", async () => {
    await get();
    const q = call("postJob", "findMany").map(argsOf).find((a) => a.take === 5 && a.where.approvalStatus === "pending");
    expect(q).toMatchObject({
      where: { workspaceId: "ws-1", status: "draft", approvalStatus: "pending" },
      orderBy: [{ submittedAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      take: 5,
    });
  });

  it("sends the queue as data: who sent it, the round, the format's parts and the pillar, never the content", async () => {
    h.queue = [queued()];
    const body = (await get()).json();
    expect(body.queue).toEqual([
      {
        id: "p1",
        status: "draft",
        approvalStatus: "pending",
        title: "Backcasting 2026",
        thumbnail: "/uploads/a.png",
        pillar: "Promotional",
        media: { images: 2, video: false, mediaType: null, youtubeType: null },
        submitCount: 2,
        submittedAt: "2026-11-14T02:00:00.000Z",
        submittedBy: "Dewi K.",
        scheduledFor: "2026-11-20T02:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("a long secret paragraph");
  });
});

describe("GET /dashboard/design: recent activities", () => {
  it("asks for the last seven days of sends and of answers, five of each", async () => {
    await get();
    const since = new Date("2026-11-10T05:00:00Z");
    const sent = call("postJob", "findMany").map(argsOf).find((a) => a.where.submittedAt);
    const answered = call("postJob", "findMany").map(argsOf).find((a) => a.where.reviewedAt);
    expect(sent).toMatchObject({ where: { workspaceId: "ws-1", submittedAt: { gte: since } }, orderBy: [{ submittedAt: "desc" }, { id: "asc" }], take: 5 });
    expect(answered).toMatchObject({
      where: { workspaceId: "ws-1", approvalStatus: { in: ["approved", "rejected"] }, reviewedAt: { gte: since } },
      orderBy: [{ reviewedAt: "desc" }, { id: "asc" }],
      take: 5,
    });
  });

  it("merges them with the templates, newest first, and says which the asking person did", async () => {
    h.submitted = [
      { content: JSON.stringify({ title: "Satellite Imagery 101" }), submittedAt: new Date("2026-11-16T07:22:00Z"), submittedById: "rina", submittedBy: { name: "Rina S." }, user: { name: "Rina S." } },
    ];
    h.reviewed = [
      { content: JSON.stringify({ title: "Behind the Scenes" }), approvalStatus: "approved", reviewedAt: new Date("2026-11-17T01:55:00Z"), reviewedByUserId: "dewi", reviewedBy: { name: "Dewi K." } },
    ];
    h.templates = [{ name: "Case Study", pillar: "Promotional", published: true, createdAt: new Date("2026-11-16T09:00:00Z"), userId: "dewi", user: { name: "Dewi K." } }];
    const { activities } = (await get()).json();
    expect(activities.map((a: { kind: string; title: string; mine: boolean }) => [a.kind, a.title, a.mine])).toEqual([
      ["approved", "Behind the Scenes", true],
      ["template", "Case Study", true],
      ["submitted", "Satellite Imagery 101", false],
    ]);
  });

  it("an event older than seven days is not shown", async () => {
    h.templates = [{ name: "Blog Post", pillar: "Educational", published: false, createdAt: new Date("2026-11-01T00:00:00Z"), userId: "dewi", user: null }];
    expect((await get()).json().activities).toEqual([]);
  });
});

describe("GET /dashboard/design: templates", () => {
  it("sends the pillar and the link of each template of the workspace, and nothing else about them", async () => {
    h.templates = [
      { name: "Case Study", pillar: "Promotional", published: true, createdAt: new Date("2026-01-01T00:00:00Z"), userId: "dewi", user: { name: "Dewi K." } },
      { name: "Blog Post", pillar: "Educational", published: false, createdAt: new Date("2026-01-02T00:00:00Z"), userId: "dewi", user: null },
    ];
    expect((await get()).json().templates).toEqual([
      { pillar: "Promotional", published: true },
      { pillar: "Educational", published: false },
    ]);
  });

  it("reads only the templates that have a category, of this workspace", async () => {
    await get();
    expect(argsOf(call("template", "findMany")[0])).toMatchObject({ where: { workspaceId: "ws-1", category: { not: null } } });
  });
});

describe("GET /dashboard/design: every post query stays in the workspace", () => {
  it("no query reads another workspace's posts", async () => {
    await get();
    const post = h.calls.filter((c) => c.model === "postJob");
    expect(post.length).toBeGreaterThan(0);
    for (const c of post) expect(argsOf(c).where.workspaceId).toBe("ws-1");
  });
});
