// GET /dashboard/design: the design team's dashboard. These tests drive the route with a fake database and check
// who may call it, that every query is the asking designer's own, and that nothing but data leaves (never the content JSON).
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "designer" as string | null,
  userId: "dewi",
  calls: [] as Array<{ model: string; fn: string; args: unknown }>,
  counts: { assigned: 0, progress: 0, done: 0, waiting: 0 },
  open: [] as unknown[],
  assigned: [] as unknown[],
  answered: [] as unknown[],
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
      designRequest: {
        count: record("designRequest", "count", (args) => {
          const json = JSON.stringify(args);
          if (json.includes('"postJob"')) return h.counts.waiting;
          if (json.includes('"status":"done"')) return h.counts.done;
          if (json.includes('"OR"')) return h.counts.progress;
          return h.counts.assigned;
        }),
        findMany: record("designRequest", "findMany", (args) => {
          const json = JSON.stringify(args);
          if (json.includes('"sentAt":{"gte"')) return h.assigned;
          if (json.includes('"doneAt":{"gte"')) return h.answered;
          return h.open;
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
  jobVisibilityWhere: () => ({}),
  getWorkspaceRole: async () => h.role,
}));

import { dashboardRoutes } from "./dashboard.js";

let app: FastifyInstance;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T05:00:00Z")); // 12:00 WIB on Tue 17 Nov 2026
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
  h.counts = { assigned: 0, progress: 0, done: 0, waiting: 0 };
  h.open = [];
  h.assigned = [];
  h.answered = [];
  h.templates = [];
});

const get = () => app.inject({ method: "GET", url: "/dashboard/design" });
const call = (model: string, fn: string) => h.calls.filter((c) => c.model === model && c.fn === fn);
const argsOf = (c: { args: unknown }) => c.args as Record<string, any>;

const task = (patch: Record<string, unknown> = {}) => ({
  id: "dr1",
  status: "sent",
  deadline: new Date("2026-11-20T10:00:00Z"),
  brief: "5 slides, serious tone",
  referenceUrl: null,
  sentAt: new Date("2026-11-16T03:00:00Z"),
  doneAt: null,
  updatedAt: new Date("2026-11-16T03:00:00Z"),
  figmaUrl: null,
  designerNote: null,
  createdById: "rina",
  createdBy: { name: "Rina A." },
  postJob: {
    id: "p1",
    status: "draft",
    approvalStatus: null,
    scheduledFor: new Date("2026-11-21T02:00:00Z"),
    content: JSON.stringify({ title: "Backcasting 2026", mediaUrls: ["/uploads/a.png"], category: "Case Study", format: "carousel", designCopy: "a long secret paragraph" }),
    userId: "rina",
    user: { name: "Rina A." },
    targets: [{ account: { platform: "linkedin", displayName: "Braga" } }],
  },
  ...patch,
});

describe("GET /dashboard/design: who may call it", () => {
  it("a designer may", async () => {
    expect((await get()).statusCode).toBe(200);
  });

  // approving is the admin's now: the owner and admin have their own dashboard, and a member is not on the design team
  it.each(["admin", "owner", "member", null])("a %s may not: 403, and nothing is read", async (role) => {
    h.role = role as string | null;
    const res = await get();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("GET /dashboard/design: the numbers", () => {
  it("sends the four counts of the designer's own tasks", async () => {
    h.counts = { assigned: 2, progress: 1, done: 3, waiting: 2 };
    expect((await get()).json().counts).toEqual({ assigned: 2, progress: 1, done: 3, waiting: 2 });
  });

  it("a designer with no task has zeros, not holes", async () => {
    expect((await get()).json().counts).toEqual({ assigned: 0, progress: 0, done: 0, waiting: 0 });
  });

  it("every count is this workspace's and this designer's", async () => {
    await get();
    const counts = call("designRequest", "count");
    expect(counts).toHaveLength(4);
    for (const c of counts) expect(argsOf(c).where).toMatchObject({ workspaceId: "ws-1", assigneeId: "dewi" });
  });

  it("waiting counts done tasks whose post Marketing has not sent for review (a plain draft)", async () => {
    await get();
    const waiting = call("designRequest", "count").map(argsOf).find((a) => a.where.postJob);
    expect(waiting?.where).toMatchObject({ status: "done", postJob: { status: "draft" } });
  });
});

describe("GET /dashboard/design: the open tasks", () => {
  it("asks for the five open tasks with the soonest deadline, none last, of this designer", async () => {
    await get();
    const q = call("designRequest", "findMany").map(argsOf).find((a) => a.take === 5 && a.where.status === "sent");
    expect(q).toMatchObject({
      where: { workspaceId: "ws-1", assigneeId: "dewi", status: "sent" },
      orderBy: [{ status: "desc" }, { deadline: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      take: 5,
    });
  });

  it("sends a task as data: who assigned it, the format, the pillar and when, never the content", async () => {
    h.open = [task()];
    const body = (await get()).json();
    expect(body.tasks).toEqual([
      {
        postId: "p1",
        title: "Backcasting 2026",
        thumbnail: "/uploads/a.png",
        pillar: "Promotional",
        format: "carousel",
        status: "assigned",
        assignedBy: "Rina A.",
        deadline: "2026-11-20T10:00:00.000Z",
        sentAt: "2026-11-16T03:00:00.000Z",
        doneAt: null,
        scheduledFor: "2026-11-21T02:00:00.000Z",
        channels: ["linkedin"],
        brief: "5 slides, serious tone",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("a long secret paragraph");
  });

  it("a task with a saved link or note is in progress", async () => {
    h.open = [task({ figmaUrl: "https://www.figma.com/design/abc/x" })];
    expect((await get()).json().tasks[0].status).toBe("progress");
  });

  it("a task with no deadline has none, and a post with no date (the epoch) has no date", async () => {
    h.open = [task({ deadline: null, postJob: { ...task().postJob, scheduledFor: new Date(0) } })];
    expect((await get()).json().tasks[0]).toMatchObject({ deadline: null, scheduledFor: null });
  });
});

describe("GET /dashboard/design: recent activity", () => {
  it("asks for the last seven days of the designer's own tasks sent and answered, five of each", async () => {
    await get();
    const since = new Date("2026-11-10T05:00:00Z");
    const sent = call("designRequest", "findMany").map(argsOf).find((a) => a.where.sentAt);
    const answered = call("designRequest", "findMany").map(argsOf).find((a) => a.where.doneAt);
    expect(sent).toMatchObject({ where: { workspaceId: "ws-1", assigneeId: "dewi", sentAt: { gte: since } }, take: 5 });
    expect(answered).toMatchObject({ where: { workspaceId: "ws-1", assigneeId: "dewi", status: "done", doneAt: { gte: since } }, take: 5 });
  });

  it("merges assignments, sent designs and templates, newest first, and says which the designer did", async () => {
    h.assigned = [{ sentAt: new Date("2026-11-16T07:22:00Z"), createdBy: { name: "Rina A." }, postJob: { content: JSON.stringify({ title: "Satellite Imagery 101" }) } }];
    h.answered = [{ doneAt: new Date("2026-11-17T01:55:00Z"), postJob: { content: JSON.stringify({ title: "Braga Backcasting" }) } }];
    h.templates = [{ name: "Case Study", pillar: "Promotional", published: true, createdAt: new Date("2026-11-16T09:00:00Z"), userId: "dewi", user: { name: "Dewi K." } }];
    const { activities } = (await get()).json();
    expect(activities.map((a: { kind: string; title: string; mine: boolean; by: string | null }) => [a.kind, a.title, a.mine, a.by])).toEqual([
      ["sent", "Braga Backcasting", true, null],
      ["template", "Case Study", true, "Dewi K."],
      ["assigned", "Satellite Imagery 101", false, "Rina A."],
    ]);
  });

  it("an event older than seven days is not shown", async () => {
    h.templates = [{ name: "Blog Post", pillar: "Educational", published: false, createdAt: new Date("2026-11-01T00:00:00Z"), userId: "dewi", user: null }];
    expect((await get()).json().activities).toEqual([]);
  });
});

describe("GET /dashboard/design: templates", () => {
  it("sends the pillar and whether each template of the workspace is published, and nothing else about them", async () => {
    h.templates = [
      { name: "Case Study", pillar: "Promotional", published: true, createdAt: new Date("2026-01-01T00:00:00Z"), userId: "dewi", user: { name: "Dewi K." } },
      { name: "Blog Post", pillar: "Educational", published: false, createdAt: new Date("2026-01-02T00:00:00Z"), userId: "dewi", user: null },
    ];
    expect((await get()).json().templates).toEqual([
      { pillar: "Promotional", published: true },
      { pillar: "Educational", published: false },
    ]);
  });

  it("a designer reads the templates that have a category, of this workspace, drafts too", async () => {
    await get();
    expect(argsOf(call("template", "findMany")[0]).where).toEqual({ workspaceId: "ws-1", category: { not: null } });
  });
});

describe("GET /dashboard/design: every query stays in the workspace and is the designer's own", () => {
  it("no query reads another workspace's or another designer's tasks", async () => {
    await get();
    const tasks = h.calls.filter((c) => c.model === "designRequest");
    expect(tasks.length).toBeGreaterThan(0);
    for (const c of tasks) expect(argsOf(c).where).toMatchObject({ workspaceId: "ws-1", assigneeId: "dewi" });
  });
});
