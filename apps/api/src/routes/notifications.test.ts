// The bell and the drawer: every role reads only its own rows of the workspace, and nothing else.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: unknown }>,
  rows: [] as unknown[],
  unread: 0,
  marked: 1,
}));

vi.mock("../lib/prisma.js", () => {
  const record = (fn: string, result: () => unknown) =>
    vi.fn(async (args: unknown) => {
      h.calls.push({ fn, args });
      return result();
    });
  return {
    prisma: {
      notification: {
        findMany: record("findMany", () => h.rows),
        count: record("count", () => h.unread),
        updateMany: record("updateMany", () => ({ count: h.marked })),
      },
    },
  };
});
vi.mock("../lib/auth/withAuth.js", () => ({
  withAuth: async () => {},
  getUser: () => ({ id: "rina" }),
  getWorkspaceId: () => "ws-1",
}));

import { notificationRoutes } from "./notifications.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(notificationRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  h.calls = [];
  h.rows = [];
  h.unread = 0;
  h.marked = 1;
});

const call = (fn: string) => h.calls.filter((c) => c.fn === fn);
const argsOf = (c: { args: unknown }) => c.args as Record<string, any>;
const MINE = { userId: "rina", workspaceId: "ws-1" };

describe("GET /notifications", () => {
  it("reads the latest fifty rows of this person in this workspace, newest first, and the unread count of all of them", async () => {
    h.unread = 7;
    const res = await app.inject({ method: "GET", url: "/notifications" });
    expect(res.json()).toEqual({ items: [], unread: 7 });
    expect(argsOf(call("findMany")[0])).toMatchObject({ where: MINE, take: 50, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    expect(argsOf(call("count")[0]).where).toEqual({ ...MINE, readAt: null });
  });

  it("sends the post's title and picture (read from the post), who did it, and the reviewer's note only for a post sent back", async () => {
    h.rows = [
      { id: "n1", kind: "post_sent_back", postJobId: "p1", readAt: null, createdAt: new Date("2026-11-13T03:24:00Z"), actor: { name: "Putri A." }, postJob: { content: JSON.stringify({ title: "Backcasting", mediaUrls: ["/uploads/a.png"], designCopy: "secret" }), reviewNote: "Make the timeline readable" } },
      { id: "n2", kind: "design_done", postJobId: "p2", readAt: new Date("2026-11-12T09:40:00Z"), createdAt: new Date("2026-11-12T09:00:00Z"), actor: null, postJob: { content: JSON.stringify({ title: "Platform" }), reviewNote: "left over from an old review" } },
    ];
    const res = await app.inject({ method: "GET", url: "/notifications" });
    expect(res.json().items).toEqual([
      { id: "n1", kind: "post_sent_back", postId: "p1", title: "Backcasting", thumbnail: "/uploads/a.png", by: "Putri A.", note: "Make the timeline readable", read: false, at: "2026-11-13T03:24:00.000Z" },
      { id: "n2", kind: "design_done", postId: "p2", title: "Platform", thumbnail: null, by: null, note: null, read: true, at: "2026-11-12T09:00:00.000Z" },
    ]);
    expect(res.body).not.toContain("secret");
  });
});

describe("the bell", () => {
  it("unread-count is one count of this person's unread rows", async () => {
    h.unread = 3;
    expect((await app.inject({ method: "GET", url: "/notifications/unread-count" })).json()).toEqual({ unread: 3 });
    expect(argsOf(call("count")[0]).where).toEqual({ ...MINE, readAt: null });
  });
});

describe("marking read", () => {
  it("read-all marks only this person's unread rows of this workspace", async () => {
    const res = await app.inject({ method: "POST", url: "/notifications/read-all" });
    expect(res.json()).toEqual({ marked: 1 });
    const q = argsOf(call("updateMany")[0]);
    expect(q.where).toEqual({ ...MINE, readAt: null });
    expect(q.data.readAt).toBeInstanceOf(Date);
  });

  it("one row is marked only when it is this person's: another person's id changes nothing", async () => {
    h.marked = 0;
    const res = await app.inject({ method: "POST", url: "/notifications/someone-elses/read" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ marked: 0 });
    expect(argsOf(call("updateMany")[0]).where).toEqual({ ...MINE, id: "someone-elses", readAt: null });
  });
});
