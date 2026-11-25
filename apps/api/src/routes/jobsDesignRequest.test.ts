// What a design request and the new content keys (format, designFigmaUrl, canvas) change in routes/jobs.ts:
// a post whose design is with the designer cannot be sent on, and an edit keeps every key it does not send.
// Same fake database as jobsTeamDrafts.test.ts.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "member" as string | null,
  viewer: "colleague",
  job: null as null | Record<string, unknown>,
  jobs: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ fn: string; args: unknown }>,
  notified: [] as unknown[],
  admins: [] as unknown[],
}));

vi.mock("../lib/prisma.js", () => {
  const record = (fn: string, result: (args: unknown) => unknown) =>
    vi.fn(async (args: unknown) => {
      h.calls.push({ fn, args });
      return result(args);
    });
  return {
    prisma: {
      postJob: {
        findFirst: record("findFirst", () => h.job),
        findMany: record("findMany", () => h.jobs),
        update: record("update", (args) => ({ id: "p1", ...(args as { data: object }).data })),
        updateMany: record("updateMany", () => ({ count: 1 })),
      },
      workspace: { findUnique: record("workspace.findUnique", () => ({ approvalRequired: true, plan: "pro" })) },
      postJobTarget: { findMany: record("target.findMany", () => []), deleteMany: record("target.deleteMany", () => ({})), createMany: record("target.createMany", () => ({})) },
      account: { findMany: record("account.findMany", () => []) },
      $transaction: async (fn: (tx: unknown) => unknown) => fn({ postJob: { create: record("create", (args) => ({ id: "new", ...(args as { data: object }).data })) } }),
      upload: { deleteMany: record("upload.deleteMany", () => ({ count: 1 })), updateMany: record("upload.updateMany", () => ({ count: 1 })) },
    },
  };
});
vi.mock("../lib/auth/withAuth.js", async () => {
  const real = await vi.importActual<typeof import("../lib/auth/withAuth.js")>("../lib/auth/withAuth.js");
  return {
    ...real,
    withAuth: async () => {},
    getUser: () => ({ id: h.viewer }),
    getWorkspaceId: () => "ws-1",
    getWorkspaceRole: async () => h.role,
    requireContentEditorRole: async () => (h.role === "designer" ? { error: "Content is created and edited by Admin and Marketing only.", code: "FORBIDDEN" } : null),
    // the real rule (owner/admin only): the mock stands in for the database read of the role, not for what the role may do
    requireManageRole: async () => (real.isManageRole(h.role) ? null : { error: real.MANAGE_FORBIDDEN_MSG, code: "FORBIDDEN" }),
  };
});
vi.mock("../lib/queue.js", () => ({ schedulePostJob: vi.fn(), postJobQueue: { remove: vi.fn(async () => {}) } }));
vi.mock("../lib/notifications.js", () => ({
  notify: vi.fn(async (rows: unknown[]) => void h.notified.push(...rows)),
  notifyAdmins: vi.fn(async (...args: unknown[]) => void h.admins.push(args)),
}));
vi.mock("../lib/enforcePlan.js", () => ({ enforcePlan: async () => null }));
vi.mock("../lib/templates.js", () => ({ withoutTemplateMedia: async (urls: string[]) => urls }));
vi.mock("../lib/auth/index.js", () => ({ authProvider: {} }));
vi.mock("../adapters/index.js", () => ({ adapters: [] }));

import { jobRoutes } from "./jobs.js";

const storage = { upload: vi.fn(), delete: vi.fn(async () => {}), list: vi.fn(), isLocal: () => true };

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(jobRoutes, { storage } as never);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  h.role = "member";
  h.viewer = "colleague";
  h.job = null;
  h.jobs = [];
  h.calls = [];
  h.notified = [];
  h.admins = [];
});

const STORED = { title: "T", text: "Caption", category: "Blog Post", format: "single", mediaUrls: ["/uploads/a.png"], youtubeTags: ["geo"], assetNotes: "from the plan" };

const draft = (patch: Record<string, unknown> = {}) => ({
  id: "p1",
  status: "draft",
  approvalStatus: null,
  userId: "head-of-marketing",
  scheduledFor: new Date("2026-03-07T01:00:00Z"),
  commentText: null,
  content: JSON.stringify(STORED),
  targets: [{ accountId: "acc-1", account: { platform: "instagram" } }],
  designRequest: null,
  ...patch,
});

const call = (fn: string) => h.calls.filter((c) => c.fn === fn);
const patchJob = (body: object) => app.inject({ method: "PATCH", url: "/jobs/p1", payload: body });
const savedContent = () => JSON.parse((call("update")[0].args as { data: { content: string } }).data.content) as Record<string, unknown>;
const SENT = { designRequest: { status: "sent" } };

describe("a design request that is with the designer blocks sending the post on", () => {
  it("submit: 409 IN_DESIGN and nothing is written", async () => {
    h.job = draft(SENT);
    const res = await app.inject({ method: "POST", url: "/jobs/p1/submit" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "IN_DESIGN" });
    expect(call("update")).toHaveLength(0);
  });

  it("a saved brief that was not sent does not block", async () => {
    h.job = draft({ designRequest: { status: "draft" } });
    expect((await app.inject({ method: "POST", url: "/jobs/p1/submit" })).statusCode).toBe(200);
  });

  it("the write itself refuses a post whose request is sent, so a send at the same moment as Send Design Request cannot win", async () => {
    h.job = draft();
    await app.inject({ method: "POST", url: "/jobs/p1/submit" });
    expect(call("update")[0].args).toMatchObject({ where: { NOT: { designRequest: { is: { status: "sent" } } } } });
  });

  it("bulk submit skips it with the reason, and sends the others", async () => {
    const ids = ["ckaaaaaaaaaaaaaaaaaaaaaaa", "ckbbbbbbbbbbbbbbbbbbbbbbb"];
    h.jobs = [draft({ id: ids[0], ...SENT }), draft({ id: ids[1] })];
    const json = (await app.inject({ method: "POST", url: "/jobs/submit-bulk", payload: { ids } })).json();
    expect(json.submitted).toEqual([ids[1]]);
    expect(json.skipped).toEqual([expect.objectContaining({ id: ids[0], reason: "Design requested: waiting for the designer" })]);
    expect(call("updateMany")[0].args).toMatchObject({ where: { NOT: { designRequest: { is: { status: "sent" } } } } });
  });

  it("schedule of a plain draft is refused for an admin (an admin only sees their own plain drafts)", async () => {
    h.role = "admin";
    h.job = draft({ ...SENT, userId: "colleague" });
    const res = await app.inject({ method: "POST", url: "/jobs/p1/schedule", payload: { scheduledFor: "2030-01-01T01:00:00.000Z" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "IN_DESIGN" });
    expect(call("update")).toHaveLength(0);
  });

  it("approving a post already in review is not blocked by the request", async () => {
    h.role = "admin";
    h.job = draft({ ...SENT, approvalStatus: "pending", submittedById: "marketing-1" });
    const res = await app.inject({ method: "POST", url: "/jobs/p1/schedule", payload: { scheduledFor: "2030-01-01T01:00:00.000Z" } });
    expect(res.statusCode).toBe(200);
  });
});

describe("approving is the owner's and the admin's: the design team may not", () => {
  const schedule = () => app.inject({ method: "POST", url: "/jobs/p1/schedule", payload: { scheduledFor: "2030-01-01T01:00:00.000Z" } });
  const reject = () => app.inject({ method: "POST", url: "/jobs/p1/reject", payload: { note: "Make the timeline readable" } });

  it("a designer cannot approve or send back a post in review: 403, and nothing is written", async () => {
    h.role = "designer";
    h.job = draft({ approvalStatus: "pending" });
    for (const res of [await schedule(), await reject()]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("Only workspace owners and admins can perform this action.");
    }
    expect(call("update")).toHaveLength(0);
  });

  it.each(["admin", "owner"])("an %s approves a post in review, and the person who sent it is told", async (role) => {
    h.role = role;
    h.job = draft({ approvalStatus: "pending", submittedById: "marketing-1" });
    expect((await schedule()).statusCode).toBe(200);
    expect(h.notified).toEqual([{ workspaceId: "ws-1", userId: "marketing-1", kind: "post_approved", postJobId: "p1", actorId: "colleague" }]);
  });

  it("an approval with no recorded sender tells the post's author", async () => {
    h.role = "admin";
    h.job = draft({ approvalStatus: "pending", submittedById: null });
    await schedule();
    expect(h.notified).toMatchObject([{ userId: "head-of-marketing", kind: "post_approved" }]);
  });

  it("scheduling a plain draft is nobody's answer: nobody is told", async () => {
    h.role = "admin";
    h.job = draft({ userId: "colleague" });
    expect((await schedule()).statusCode).toBe(200);
    expect(h.notified).toEqual([]);
  });

  it("sending a post back tells the person who sent it", async () => {
    h.role = "admin";
    h.job = draft({ approvalStatus: "pending", submittedById: "marketing-1" });
    expect((await reject()).statusCode).toBe(200);
    expect(h.notified).toEqual([{ workspaceId: "ws-1", userId: "marketing-1", kind: "post_sent_back", postJobId: "p1", actorId: "colleague" }]);
  });
});

describe("sending a post for review tells the owners and admins", () => {
  it("submit: one fact for the post", async () => {
    h.job = draft();
    expect((await app.inject({ method: "POST", url: "/jobs/p1/submit" })).statusCode).toBe(200);
    expect(h.admins).toEqual([["ws-1", "review_submitted", ["p1"], "colleague"]]);
  });

  it("a submit that is refused (the design is with the designer) tells nobody", async () => {
    h.job = draft(SENT);
    await app.inject({ method: "POST", url: "/jobs/p1/submit" });
    expect(h.admins).toEqual([]);
  });

  it("bulk submit: only the posts that were sent", async () => {
    const ids = ["ckaaaaaaaaaaaaaaaaaaaaaaa", "ckbbbbbbbbbbbbbbbbbbbbbbb"];
    h.jobs = [draft({ id: ids[0], ...SENT }), draft({ id: ids[1] })];
    await app.inject({ method: "POST", url: "/jobs/submit-bulk", payload: { ids } });
    expect(h.admins).toEqual([["ws-1", "review_submitted", [ids[1]], "colleague"]]);
  });
});

describe("PATCH /jobs/:id: the new content keys, and every key that is not sent is kept", () => {
  it("saves format and the Figma link, and keeps what it was not sent (YouTube tags, the plan's notes, the pictures)", async () => {
    h.job = draft();
    expect((await patchJob({ format: "carousel", designFigmaUrl: "https://www.figma.com/design/abc/x" })).statusCode).toBe(200);
    expect(savedContent()).toEqual({ ...STORED, format: "carousel", designFigmaUrl: "https://www.figma.com/design/abc/x" });
  });

  it("an empty link clears the Figma link, and null clears the format", async () => {
    h.job = draft({ content: JSON.stringify({ ...STORED, designFigmaUrl: "https://figma.com/a" }) });
    await patchJob({ designFigmaUrl: "", format: null });
    expect(savedContent()).toMatchObject({ designFigmaUrl: "", format: null });
  });

  it("refuses a format that is not single or carousel, and a link that is not https", async () => {
    h.job = draft();
    expect((await patchJob({ format: "reel" })).statusCode).toBe(400);
    expect((await patchJob({ designFigmaUrl: "http://figma.com/a" })).statusCode).toBe(400);
    expect((await patchJob({ designFigmaUrl: "javascript:alert(1)" })).statusCode).toBe(400);
    expect(call("update")).toHaveLength(0);
  });

  it("an edit that sends nothing writes no content", async () => {
    h.job = draft();
    await patchJob({});
    expect((call("update")[0].args as { data: Record<string, unknown> }).data).not.toHaveProperty("content");
  });

  it("the canvas keys are saved, and they do not take a post out of review (opening the Studio is not an edit)", async () => {
    h.job = draft({ approvalStatus: "pending" });
    await patchJob({ canvasInstanceId: "ckaaaaaaaaaaaaaaaaaaaaaaa", canvasTemplateId: "ckbbbbbbbbbbbbbbbbbbbbbbb" });
    const data = (call("update")[0].args as { data: Record<string, unknown> }).data;
    expect(savedContent()).toMatchObject({ canvasInstanceId: "ckaaaaaaaaaaaaaaaaaaaaaaa", canvasTemplateId: "ckbbbbbbbbbbbbbbbbbbbbbbb" });
    expect(data).not.toHaveProperty("approvalStatus");
  });

  it("a real content change in the same request still takes it out of review", async () => {
    h.job = draft({ approvalStatus: "pending" });
    await patchJob({ canvasInstanceId: "ckaaaaaaaaaaaaaaaaaaaaaaa", text: "A new caption" });
    expect(call("update")[0].args).toMatchObject({ data: { approvalStatus: null } });
  });
});

describe("a draft may have no account yet", () => {
  it("POST /jobs: a draft with no accounts is created", async () => {
    const res = await app.inject({ method: "POST", url: "/jobs", payload: { draft: true, content: { text: "x" } } });
    expect(res.statusCode).toBe(201);
    expect(call("create")[0].args).toMatchObject({ data: { targets: { create: [] } } });
  });

  it("POST /jobs: a scheduled post with no accounts is refused", async () => {
    const res = await app.inject({ method: "POST", url: "/jobs", payload: { scheduledFor: "2030-01-01T01:00:00.000Z", content: { text: "x" } } });
    expect(res.statusCode).toBe(400);
    expect(call("create")).toHaveLength(0);
  });

  it("PATCH: a plain draft can be left with no account", async () => {
    h.job = draft();
    expect((await patchJob({ accountIds: [] })).statusCode).toBe(200);
  });

  it("PATCH: a post in review, or a scheduled one, cannot", async () => {
    h.job = draft({ approvalStatus: "pending" });
    expect((await patchJob({ accountIds: [] })).statusCode).toBe(400);
    h.role = "admin";
    h.job = draft({ status: "pending" });
    expect((await patchJob({ accountIds: [] })).statusCode).toBe(400);
    expect(call("update")).toHaveLength(0);
  });
});

describe("GET /jobs/:id answers the design request as a view", () => {
  it("includes it with the assignee and whether they are still a designer here", async () => {
    h.job = {
      ...draft(),
      designRequest: {
        id: "dr1", status: "sent", deadline: new Date("2026-03-04T00:00:00Z"), brief: "5 slides", referenceUrl: null, sentAt: new Date("2026-03-01T01:00:00Z"), updatedAt: new Date("2026-03-01T01:00:00Z"), figmaUrl: "https://www.figma.com/design/a/draft", designerNote: "draft note", doneAt: null,
        assignee: { id: "u9", name: "Rina S.", avatarUrl: null, workspaceMembers: [] },
      },
    };
    const res = await app.inject({ method: "GET", url: "/jobs/p1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().designRequest).toMatchObject({ status: "sent", deadline: "2026-03-04T00:00:00.000Z", assignee: { name: "Rina S.", active: false } });
  });

  it("the designer's saved link and note are the designer's own: Marketing sees them only once the request is done", async () => {
    const dr = { id: "dr1", status: "sent", deadline: null, brief: "b", referenceUrl: null, sentAt: new Date("2026-03-01T01:00:00Z"), updatedAt: new Date("2026-03-01T01:00:00Z"), figmaUrl: "https://www.figma.com/design/a/draft", designerNote: "draft note", doneAt: null, assignee: { id: "u9", name: "Rina S.", avatarUrl: null, workspaceMembers: [] } };
    h.job = { ...draft(), designRequest: dr };
    expect((await app.inject({ method: "GET", url: "/jobs/p1" })).json().designRequest).toMatchObject({ figmaUrl: null, designerNote: null, doneAt: null });
    h.job = { ...draft(), designRequest: { ...dr, status: "done", doneAt: new Date("2026-03-03T08:00:00Z") } };
    expect((await app.inject({ method: "GET", url: "/jobs/p1" })).json().designRequest).toMatchObject({ status: "done", figmaUrl: "https://www.figma.com/design/a/draft", designerNote: "draft note", doneAt: "2026-03-03T08:00:00.000Z" });
  });

  it("is null when the post has no request", async () => {
    h.job = draft();
    expect((await app.inject({ method: "GET", url: "/jobs/p1" })).json().designRequest).toBeNull();
  });
});
