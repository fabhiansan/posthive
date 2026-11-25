// My Task: the routes only the design team uses, and only for the tasks sent to the person asking. A fake database records
// every query so the tests can say "this designer's own, in this workspace" and "a task Marketing sees is the answer, not the draft".
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "designer" as string | null,
  userId: "dewi",
  calls: [] as Array<{ fn: string; args: unknown }>,
  task: null as null | Record<string, unknown>,
  list: [] as unknown[],
  updated: 1,
  figma: { state: "valid", title: "Braga Backcasting" } as { state: string; title?: string | null },
  notified: [] as unknown[],
  emails: [] as unknown[],
}));

vi.mock("../lib/prisma.js", () => {
  const record = (fn: string, result: (args: unknown) => unknown) =>
    vi.fn(async (args: unknown) => {
      h.calls.push({ fn, args });
      return result(args);
    });
  const tx = {
    $queryRaw: record("tx.lock", () => []),
    user: { findUnique: record("tx.user", () => ({ name: "Dewi K." })) },
    designRequest: { findFirst: record("tx.dr.findFirst", () => h.task), updateMany: record("tx.dr.updateMany", () => ({ count: h.updated })) },
    postJob: { update: record("tx.post.update", () => ({})) },
  };
  return {
    prisma: {
      designRequest: {
        count: record("dr.count", () => 0),
        findMany: record("dr.findMany", () => h.list),
        findFirst: record("dr.findFirst", () => h.task),
        updateMany: record("dr.updateMany", () => ({ count: h.updated })),
      },
      user: { findUnique: record("user.findUnique", (args) => ((args as { select: { email?: true } }).select.email ? { email: "rina@x.co" } : { name: "Dewi K." })) },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});
vi.mock("../lib/auth/withAuth.js", () => ({
  withAuth: async () => {},
  getUser: () => ({ id: h.userId }),
  getWorkspaceId: () => "ws-1",
  getWorkspaceRole: async () => h.role,
}));
vi.mock("../lib/figmaCheck.js", () => ({ checkFigmaLink: vi.fn(async () => h.figma) }));
vi.mock("../lib/notifications.js", () => ({ notify: vi.fn(async (rows: unknown[]) => void h.notified.push(...rows)) }));
vi.mock("../lib/mailer.js", () => ({ sendDesignDoneEmail: vi.fn(async (...args: unknown[]) => void h.emails.push(args)) }));

import { designTaskRoutes } from "./designTasks.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(designTaskRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  h.role = "designer";
  h.calls = [];
  h.task = null;
  h.list = [];
  h.updated = 1;
  h.figma = { state: "valid", title: "Braga Backcasting" };
  h.notified = [];
  h.emails = [];
});

const call = (fn: string) => h.calls.filter((c) => c.fn === fn);
const argsOf = (c: { args: unknown }) => c.args as Record<string, any>;
const LINK = "https://www.figma.com/design/Xk3aPq/env-enforcement";

const row = (patch: Record<string, unknown> = {}) => ({
  id: "dr1",
  status: "sent",
  deadline: new Date("2026-03-04T10:00:00Z"),
  brief: "Carousel 5 slides",
  referenceUrl: "https://notion.so/brief",
  sentAt: new Date("2026-03-01T03:00:00Z"),
  doneAt: null,
  updatedAt: new Date("2026-03-02T03:00:00Z"),
  figmaUrl: null,
  designerNote: null,
  createdById: "rina",
  createdBy: { name: "Rina A." },
  postJob: {
    id: "p1",
    status: "draft",
    approvalStatus: null,
    scheduledFor: new Date("2026-03-07T01:00:00Z"),
    content: JSON.stringify({ title: "Env data", text: "Most regional monitoring fails", designCopy: "https://docs.google.com/x", assetNotes: "a folder, ask Rina", format: "carousel", mediaUrls: ["/uploads/a.png"], privateKey: "never sent" }),
    userId: "rina",
    user: { name: "Rina A." },
    targets: [{ account: { platform: "linkedin", displayName: "Braga" } }],
  },
  ...patch,
});

describe("who may use My Task", () => {
  it.each([
    ["GET", "/design-tasks"],
    ["GET", "/design-tasks/p1"],
    ["POST", "/design-tasks/check-link"],
    ["PUT", "/design-tasks/p1/draft"],
    ["POST", "/design-tasks/p1/done"],
  ])("%s %s: 403 for Marketing, admin, owner and a stranger, and nothing is read or written", async (method, url) => {
    for (const role of ["member", "admin", "owner", null]) {
      h.role = role;
      h.calls = [];
      const res = await app.inject({ method: method as "GET", url, payload: method === "GET" ? undefined : { url: LINK, figmaUrl: LINK } });
      expect(res.statusCode, `${role}`).toBe(403);
      expect(h.calls).toHaveLength(0);
    }
  });
});

describe("GET /design-tasks", () => {
  it("asks only for this designer's tasks of this workspace, in the tab asked for", async () => {
    await app.inject({ method: "GET", url: "/design-tasks?tab=progress" });
    const q = argsOf(call("dr.findMany")[0]);
    expect(q.where).toMatchObject({ workspaceId: "ws-1", assigneeId: "dewi", status: "sent" });
    expect(q.take).toBe(10);
  });

  it("an unknown tab is All, and a page past the end answers the last one", async () => {
    const res = await app.inject({ method: "GET", url: "/design-tasks?tab=bogus&page=99" });
    expect(res.json()).toMatchObject({ tab: "all", page: 1, pageCount: 1 });
    expect(argsOf(call("dr.findMany")[0]).where).toMatchObject({ status: { in: ["sent", "done"] } });
  });

  it("sends the rows as data, never the content", async () => {
    h.list = [row()];
    const res = await app.inject({ method: "GET", url: "/design-tasks" });
    expect(res.json().items[0]).toMatchObject({ postId: "p1", title: "Env data", status: "assigned", assignedBy: "Rina A." });
    expect(res.body).not.toContain("never sent");
  });
});

describe("GET /design-tasks/:postId", () => {
  it("another designer's task, or a post with no task, is a 404 (it does not say the post exists)", async () => {
    h.task = null;
    const res = await app.inject({ method: "GET", url: "/design-tasks/p1" });
    expect(res.statusCode).toBe(404);
    expect(argsOf(call("dr.findFirst")[0]).where).toMatchObject({ workspaceId: "ws-1", assigneeId: "dewi", postJobId: "p1", status: { in: ["sent", "done"] } });
  });

  it("a saved brief that was never sent is not a task", async () => {
    await app.inject({ method: "GET", url: "/design-tasks/p1" });
    expect(argsOf(call("dr.findFirst")[0]).where.status).toEqual({ in: ["sent", "done"] });
  });

  it("sends what Marketing wrote and the designer's own draft, and the links the editor kept", async () => {
    h.task = row({ figmaUrl: LINK, designerNote: "Slide 3 is new" });
    const { task } = (await app.inject({ method: "GET", url: "/design-tasks/p1" })).json();
    expect(task).toMatchObject({
      postId: "p1",
      status: "progress",
      caption: "Most regional monitoring fails",
      briefFull: "Carousel 5 slides",
      referenceUrl: "https://notion.so/brief",
      copywriting: { link: "https://docs.google.com/x", text: "" },
      assets: { link: null, text: "a folder, ask Rina" },
      figmaUrl: LINK,
      designerNote: "Slide 3 is new",
    });
    expect(JSON.stringify(task)).not.toContain("never sent");
  });
});

describe("PUT /design-tasks/:postId/draft", () => {
  const put = (body: object) => app.inject({ method: "PUT", url: "/design-tasks/p1/draft", payload: body });

  it("saves the link and note on a task that is open and this designer's, in the write's own WHERE", async () => {
    expect((await put({ figmaUrl: LINK, note: "  hello  " })).statusCode).toBe(200);
    expect(argsOf(call("dr.updateMany")[0])).toMatchObject({
      where: { workspaceId: "ws-1", assigneeId: "dewi", postJobId: "p1", status: "sent" },
      data: { figmaUrl: LINK, designerNote: "hello" },
    });
  });

  it("empty strings clear the draft", async () => {
    await put({ figmaUrl: "", note: "" });
    expect(argsOf(call("dr.updateMany")[0]).data).toEqual({ figmaUrl: null, designerNote: null });
  });

  it("a link that is not Figma is refused before anything is written", async () => {
    expect((await put({ figmaUrl: "https://example.com/design/x" })).statusCode).toBe(400);
    expect((await put({ figmaUrl: "javascript:alert(1)" })).statusCode).toBe(400);
    expect(call("dr.updateMany")).toHaveLength(0);
  });

  it("a done task is locked: 409 TASK_DONE; a task that is not this designer's: 404", async () => {
    h.updated = 0;
    h.task = { id: "dr1" };
    expect(await put({ figmaUrl: LINK }).then((r) => [r.statusCode, r.json().code])).toEqual([409, "TASK_DONE"]);
    h.task = null;
    expect((await put({ figmaUrl: LINK })).statusCode).toBe(404);
  });
});

describe("POST /design-tasks/:postId/done", () => {
  const done = (body: object = { figmaUrl: LINK, note: "Slide 3 uses the new map" }) => app.inject({ method: "POST", url: "/design-tasks/p1/done", payload: body });

  it("locks the task, copies the link to the post, tells Marketing and e-mails them", async () => {
    h.task = row();
    const res = await done();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, title: "Braga Backcasting", checked: true });
    expect(argsOf(call("tx.dr.updateMany")[0])).toMatchObject({
      where: { workspaceId: "ws-1", assigneeId: "dewi", postJobId: "p1", status: "sent" },
      data: { status: "done", figmaUrl: LINK, designerNote: "Slide 3 uses the new map" },
    });
    const saved = JSON.parse(argsOf(call("tx.post.update")[0]).data.content);
    expect(saved).toMatchObject({ designFigmaUrl: LINK, title: "Env data", mediaUrls: ["/uploads/a.png"], privateKey: "never sent" });
    expect(h.notified).toEqual([{ workspaceId: "ws-1", userId: "rina", kind: "design_done", postJobId: "p1", actorId: "dewi" }]);
    await vi.waitFor(() => expect(h.emails).toHaveLength(1));
    expect(h.emails[0]).toEqual(["rina@x.co", { postTitle: "Env data", designerName: "Dewi K.", postId: "p1", note: "Slide 3 uses the new map" }]);
  });

  it("a link Figma cannot open (private or mistyped) is refused: 422, and nothing is written", async () => {
    h.figma = { state: "private" };
    h.task = row();
    const res = await done();
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("FIGMA_PRIVATE");
    expect(call("tx.dr.updateMany")).toHaveLength(0);
    expect(h.notified).toEqual([]);
  });

  it("a link that is not a Figma file is refused: 400", async () => {
    h.figma = { state: "format" };
    const res = await done({ figmaUrl: "https://example.com/x" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("FIGMA_FORMAT");
    expect(call("tx.dr.updateMany")).toHaveLength(0);
  });

  it("when Figma cannot be asked the designer is not blocked: the design is sent, unchecked", async () => {
    h.figma = { state: "unreachable" };
    h.task = row();
    const res = await done();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, checked: false, title: null });
  });

  it("an empty link is a 400; a done task is 409; another designer's task is 404", async () => {
    expect((await done({ figmaUrl: "" })).statusCode).toBe(400);
    h.task = row({ status: "done" });
    expect((await done()).statusCode).toBe(409);
    h.task = null;
    expect((await done()).statusCode).toBe(404);
    expect(call("tx.dr.updateMany")).toHaveLength(0);
  });

  it("two Mark as done at the same moment: the one that finds the task no longer sent is a 409 and tells nobody", async () => {
    h.task = row();
    h.updated = 0;
    const res = await done();
    expect(res.statusCode).toBe(409);
    expect(call("tx.post.update")).toHaveLength(0);
    expect(h.notified).toEqual([]);
  });

  it("with no recorded sender the post's author is told", async () => {
    h.task = row({ createdById: null });
    await done();
    expect(h.notified).toMatchObject([{ userId: "rina", kind: "design_done" }]);
  });
});

describe("POST /design-tasks/check-link", () => {
  it("answers Figma's verdict and writes nothing", async () => {
    const res = await app.inject({ method: "POST", url: "/design-tasks/check-link", payload: { url: LINK } });
    expect(res.json()).toEqual({ state: "valid", title: "Braga Backcasting" });
    expect(h.calls).toHaveLength(0);
  });
});
