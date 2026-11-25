// Marketing's request to a designer: who may ask, what is checked before it is saved or sent, and that a sent request
// is locked until it is cancelled. Same fake database style as jobsTeamDrafts.test.ts.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "member" as string | null,
  viewer: "marketing-1",
  job: null as null | Record<string, unknown>,
  designer: { id: "m1" } as null | { id: string },
  members: [] as Array<Record<string, unknown>>,
  updateCount: 1,
  createError: null as null | Error,
  saved: null as null | Record<string, unknown>,
  was: { assigneeId: "ckaaaaaaaaaaaaaaaaaaaaaaa" } as null | { assigneeId: string | null },
  notified: [] as unknown[],
  calls: [] as Array<{ fn: string; args: unknown }>,
}));

vi.mock("../lib/prisma.js", () => {
  const record = (fn: string, result: (args: unknown) => unknown) =>
    vi.fn(async (args: unknown) => {
      h.calls.push({ fn, args });
      return result(args);
    });
  return {
    prisma: {
      postJob: { findFirst: record("job.findFirst", () => h.job) },
      workspaceMember: {
        findFirst: record("member.findFirst", () => h.designer),
        findMany: record("member.findMany", () => h.members),
      },
      designRequest: {
        updateMany: record("dr.updateMany", () => ({ count: h.updateCount })),
        create: record("dr.create", () => {
          if (h.createError) throw h.createError;
          return h.saved;
        }),
        // the cancel route first asks who the task was with (select: { assigneeId }), then reads the whole row
        findUnique: record("dr.findUnique", (args) => ((args as { select: { id?: true } }).select.id ? h.saved : h.was)),
      },
    },
  };
});
vi.mock("../lib/auth/withAuth.js", async () => {
  const real = await vi.importActual<typeof import("../lib/auth/withAuth.js")>("../lib/auth/withAuth.js");
  return { ...real, withAuth: async () => {}, getUser: () => ({ id: h.viewer }), getWorkspaceId: () => "ws-1", getWorkspaceRole: async () => h.role };
});

vi.mock("../lib/notifications.js", () => ({ notify: vi.fn(async (rows: unknown[]) => void h.notified.push(...rows)) }));

import { designRequestRoutes } from "./designRequests.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(designRequestRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const DESIGNER = "ckaaaaaaaaaaaaaaaaaaaaaaa";
const row = (patch: Record<string, unknown> = {}) => ({
  id: "dr1", status: "draft", deadline: new Date("2030-03-04T03:00:00Z"), brief: "Five slides", referenceUrl: null, sentAt: null, updatedAt: new Date("2030-01-01T00:00:00Z"), figmaUrl: null, designerNote: null, doneAt: null,
  assignee: { id: DESIGNER, name: "Rina S.", avatarUrl: null, workspaceMembers: [{ id: "m1" }] },
  ...patch,
});
// a draft post of Marketing, to be published in 2030 (7 Mar, 08:00 WIB) so the deadline rules do not depend on today
const post = (patch: Record<string, unknown> = {}) => ({
  status: "draft", approvalStatus: null, scheduledFor: new Date("2030-03-07T01:00:00Z"), userId: "head", designRequest: null, ...patch,
});
const body = (patch: Record<string, unknown> = {}) => ({ assigneeId: DESIGNER, deadline: "2030-03-04T03:00:00.000Z", brief: "Five slides, serious tone.", ...patch });

const put = (payload: object) => app.inject({ method: "PUT", url: "/jobs/p1/design-request", payload });
const cancel = () => app.inject({ method: "POST", url: "/jobs/p1/design-request/cancel" });
const call = (fn: string) => h.calls.filter((c) => c.fn === fn);

beforeEach(() => {
  h.role = "member";
  h.viewer = "marketing-1";
  h.job = post();
  h.designer = { id: "m1" };
  h.members = [];
  h.updateCount = 1;
  h.createError = null;
  h.saved = row();
  h.was = { assigneeId: DESIGNER };
  h.notified = [];
  h.calls = [];
});

describe("GET /design-requests/designers", () => {
  it("Marketing sees the designers of the workspace: id, name and photo, no e-mail", async () => {
    h.members = [{ user: { id: DESIGNER, name: "Rina S.", avatarUrl: null } }];
    const res = await app.inject({ method: "GET", url: "/design-requests/designers" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ designers: [{ id: DESIGNER, name: "Rina S.", avatarUrl: null }] });
    expect(call("member.findMany")[0].args).toMatchObject({ where: { workspaceId: "ws-1", role: "designer" } });
    expect(JSON.stringify(call("member.findMany")[0].args)).not.toContain("email");
  });

  it("a designer cannot list (the page is not theirs)", async () => {
    h.role = "designer";
    expect((await app.inject({ method: "GET", url: "/design-requests/designers" })).statusCode).toBe(403);
    expect(call("member.findMany")).toHaveLength(0);
  });
});

describe("PUT /jobs/:id/design-request", () => {
  it("saves a brief as a draft request: created by the viewer, not sent", async () => {
    const res = await put(body());
    expect(res.statusCode).toBe(200);
    expect(call("dr.create")[0].args).toMatchObject({
      data: { workspaceId: "ws-1", postJobId: "p1", assigneeId: DESIGNER, brief: "Five slides, serious tone.", status: "draft", sentAt: null, createdById: "marketing-1" },
    });
    expect((call("dr.create")[0].args as { data: { deadline: Date } }).data.deadline.toISOString()).toBe("2030-03-04T03:00:00.000Z");
    expect(res.json().request).toMatchObject({ status: "draft", deadline: "2030-03-04T03:00:00.000Z", assignee: { name: "Rina S.", active: true } });
  });

  it("send: true sends it, with the time", async () => {
    h.saved = row({ status: "sent", sentAt: new Date() });
    const res = await put(body({ send: true }));
    expect(res.statusCode).toBe(200);
    const data = (call("dr.create")[0].args as { data: { status: string; sentAt: unknown } }).data;
    expect(data.status).toBe("sent");
    expect(data.sentAt).toBeInstanceOf(Date);
  });

  it("a saved brief is changed in place, only while it is still a draft", async () => {
    h.job = post({ designRequest: { status: "draft" } });
    expect((await put(body({ brief: "Changed" }))).statusCode).toBe(200);
    expect(call("dr.create")).toHaveLength(0);
    expect(call("dr.updateMany")[0].args).toMatchObject({ where: { postJobId: "p1", workspaceId: "ws-1", status: "draft" }, data: { brief: "Changed" } });
  });

  it("a request that is already sent is locked: 409 REQUEST_SENT, nothing written", async () => {
    h.job = post({ designRequest: { status: "sent" } });
    const res = await put(body());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "REQUEST_SENT" });
    expect(call("dr.updateMany")).toHaveLength(0);
    expect(call("dr.create")).toHaveLength(0);
  });

  it("a send that lost the race to another send finds no draft to change: 409, not a second write", async () => {
    h.job = post({ designRequest: { status: "draft" } });
    h.updateCount = 0;
    expect((await put(body({ send: true }))).statusCode).toBe(409);
  });

  it("two first saves at the same moment: the unique key decides, 409 and not 500", async () => {
    h.createError = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    expect((await put(body())).statusCode).toBe(409);
  });

  it("any other database error is not turned into a 409", async () => {
    h.createError = Object.assign(new Error("connection lost"), { code: "P1001" });
    expect((await put(body())).statusCode).toBe(500);
  });

  it("the designer must be a designer of this workspace (a member, or one of another workspace, is refused)", async () => {
    h.designer = null;
    const res = await put(body());
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_DESIGNER" });
    expect(call("member.findFirst")[0].args).toMatchObject({ where: { workspaceId: "ws-1", userId: DESIGNER, role: "designer" } });
    expect(call("dr.create")).toHaveLength(0);
  });

  it("a saved brief may have no deadline: absent or null saves it with none (a full replace clears an old one)", async () => {
    const { deadline: _skip, ...without } = body();
    expect((await put(without)).statusCode).toBe(200);
    expect(call("dr.create")[0].args).toMatchObject({ data: { deadline: null } });
    h.calls = [];
    h.job = post({ designRequest: { status: "draft" } });
    expect((await put(body({ deadline: null }))).statusCode).toBe(200);
    expect(call("dr.updateMany")[0].args).toMatchObject({ data: { deadline: null } });
  });

  it("a SENT request needs a deadline: absent or null is 400 DEADLINE_REQUIRED and nothing is written or told", async () => {
    const { deadline: _skip, ...without } = body({ send: true });
    for (const payload of [without, body({ send: true, deadline: null })]) {
      const res = await put(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "DEADLINE_REQUIRED" });
    }
    expect(call("dr.create")).toHaveLength(0);
    expect(h.notified).toEqual([]);
  });

  it("sending tells the designer about the task; saving a brief tells nobody", async () => {
    await put(body());
    expect(h.notified).toEqual([]);
    h.saved = row({ status: "sent", sentAt: new Date() });
    h.calls = [];
    h.job = post();
    await put(body({ send: true }));
    expect(h.notified).toEqual([{ workspaceId: "ws-1", userId: DESIGNER, kind: "task_assigned", postJobId: "p1", actorId: "marketing-1" }]);
  });

  it("a request the designer already answered is locked for Marketing too: 409 REQUEST_DONE", async () => {
    h.job = post({ designRequest: { status: "done" } });
    const res = await put(body());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "REQUEST_DONE" });
    expect(call("dr.updateMany")).toHaveLength(0);
    expect(call("dr.create")).toHaveLength(0);
  });

  it("a deadline in the past, or after the publishing time, is refused with its code", async () => {
    expect((await put(body({ deadline: "2020-01-01T00:00:00.000Z" }))).json()).toMatchObject({ code: "DEADLINE_PAST" });
    const late = await put(body({ deadline: "2030-03-08T00:00:00.000Z" }));
    expect(late.statusCode).toBe(400);
    expect(late.json()).toMatchObject({ code: "DEADLINE_AFTER_PUBLISH" });
    expect(call("dr.create")).toHaveLength(0);
  });

  it("the publishing DAY is allowed, only the time counts: one minute before is saved, the same minute and a minute after are refused", async () => {
    expect((await put(body({ deadline: "2030-03-07T00:59:00.000Z" }))).statusCode).toBe(200); // 07:59 WIB, the post goes out at 08:00
    expect((await put(body({ deadline: "2030-03-07T01:00:00.000Z" }))).json()).toMatchObject({ code: "DEADLINE_AFTER_PUBLISH" });
    expect((await put(body({ deadline: "2030-03-07T01:01:00.000Z" }))).json()).toMatchObject({ code: "DEADLINE_AFTER_PUBLISH" });
  });

  it("a post with no date takes any deadline that is not in the past", async () => {
    h.job = post({ scheduledFor: null });
    expect((await put(body({ deadline: "2031-01-01T00:00:00.000Z" }))).statusCode).toBe(200);
  });

  it("a post an API client made with no date holds the epoch: that is no publishing time, not 1 Jan 1970", async () => {
    h.job = post({ scheduledFor: new Date(0) });
    expect((await put(body({ deadline: "2031-01-01T00:00:00.000Z" }))).statusCode).toBe(200);
  });

  it("an empty brief, a deadline that is only a day, a made-up instant and a non-web link are refused before anything is read", async () => {
    expect((await put(body({ brief: "   " }))).statusCode).toBe(400);
    expect((await put(body({ deadline: "2030-03-04" }))).statusCode).toBe(400);
    expect((await put(body({ deadline: "2030-02-31T00:00:00.000Z" }))).statusCode).toBe(400);
    const link = await put(body({ referenceUrl: "javascript:alert(1)" }));
    expect(link.statusCode).toBe(400);
    expect(call("dr.create")).toHaveLength(0);
  });

  it("a reference link is kept when it is http(s), and left out when empty", async () => {
    await put(body({ referenceUrl: "https://www.notion.so/braga/brief" }));
    expect(call("dr.create")[0].args).toMatchObject({ data: { referenceUrl: "https://www.notion.so/braga/brief" } });
    h.calls = [];
    await put(body({ referenceUrl: "" }));
    expect(call("dr.create")[0].args).toMatchObject({ data: { referenceUrl: null } });
  });

  it("a post in review, scheduled or published has nothing left to design: 409", async () => {
    h.job = post({ approvalStatus: "pending" });
    expect((await put(body())).json()).toMatchObject({ code: "IN_REVIEW" });
    h.job = post({ status: "pending" });
    expect((await put(body())).json()).toMatchObject({ code: "NOT_DRAFT" });
    h.job = post({ status: "done" });
    expect((await put(body())).statusCode).toBe(409);
    expect(call("dr.create")).toHaveLength(0);
  });

  it("a post of another workspace is not found: the lookup is by workspace", async () => {
    h.job = null;
    expect((await put(body())).statusCode).toBe(404);
    expect(call("job.findFirst")[0].args).toMatchObject({ where: { id: "p1", workspaceId: "ws-1" } });
  });

  it("the design team cannot ask for a design", async () => {
    h.role = "designer";
    expect((await put(body())).statusCode).toBe(403);
    expect(call("job.findFirst")).toHaveLength(0);
  });
});

describe("POST /jobs/:id/design-request/cancel", () => {
  it("takes a sent request back to a draft: the lock goes, the brief stays", async () => {
    h.job = post({ designRequest: { status: "sent" } });
    h.saved = row({ status: "draft" });
    const res = await cancel();
    expect(res.statusCode).toBe(200);
    expect(call("dr.updateMany")[0].args).toMatchObject({
      where: { postJobId: "p1", workspaceId: "ws-1", status: "sent" },
      data: { status: "draft", sentAt: null, figmaUrl: null, designerNote: null },
    });
    expect(h.notified).toEqual([{ workspaceId: "ws-1", userId: DESIGNER, kind: "task_cancelled", postJobId: "p1", actorId: "marketing-1" }]);
    expect(call("dr.updateMany")[0].args).not.toMatchObject({ data: { brief: expect.anything() } });
    expect(res.json().request).toMatchObject({ status: "draft" });
  });

  it("nothing to cancel (no request, or only a saved brief): 409 NOT_SENT", async () => {
    h.updateCount = 0;
    const res = await cancel();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NOT_SENT" });
  });

  it("the design team cannot cancel, and a post of another workspace is not found", async () => {
    h.role = "designer";
    expect((await cancel()).statusCode).toBe(403);
    h.role = "member";
    h.job = null;
    expect((await cancel()).statusCode).toBe(404);
    expect(call("dr.updateMany")).toHaveLength(0);
  });
});
