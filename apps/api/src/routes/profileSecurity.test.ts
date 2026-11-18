// The profile page's devices and activity. The fake database keeps the rows, applies the `where` of each query,
// and the tests check what a person is shown and what they can end: only their own sessions, never another person's.
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Session = { id: string; userId: string; userAgent: string | null; createdAt: Date; lastActiveAt: Date; expiresAt: Date };
type Event = { id: string; userId: string; at: Date; userAgent: string | null; failure: string | null };

const h = vi.hoisted(() => ({
  userId: "me",
  sessionId: "s-this" as string | undefined,
  role: "member" as string | null,
  sessions: [] as Session[],
  events: [] as Event[],
  calls: [] as Array<{ model: string; fn: string; args: any }>,
  counts: {} as Record<string, number>,
  targets: [] as Array<{ accountId: string }>,
  accounts: [] as Array<{ platform: string }>,
  revokeOthers: vi.fn(async () => {}),
  hasRevoke: true,
}));

const matchSession = (s: Session, where: any) =>
  (where.id === undefined || s.id === where.id) &&
  (where.userId === undefined || s.userId === where.userId) &&
  (where.expiresAt?.gt === undefined || s.expiresAt > where.expiresAt.gt);

vi.mock("../lib/prisma.js", () => {
  const rec = (model: string, fn: string, run: (args: any) => unknown) =>
    vi.fn(async (args: any) => {
      h.calls.push({ model, fn, args });
      return run(args);
    });
  return {
    prisma: {
      authSession: {
        findMany: rec("authSession", "findMany", (a) => h.sessions.filter((s) => matchSession(s, a.where)).sort((x, y) => y.lastActiveAt.getTime() - x.lastActiveAt.getTime()).slice(0, a.take)),
        deleteMany: rec("authSession", "deleteMany", (a) => {
          const hit = h.sessions.filter((s) => matchSession(s, a.where));
          h.sessions = h.sessions.filter((s) => !hit.includes(s));
          return { count: hit.length };
        }),
      },
      loginEvent: {
        // a line worked when it has no failure (the table's `success` column)
        findMany: rec("loginEvent", "findMany", (a) => h.events.filter((e) => e.userId === a.where.userId && e.at >= a.where.at.gte && (e.failure === null) === a.where.success).sort((x, y) => y.at.getTime() - x.at.getTime()).slice(0, a.take)),
      },
      postJob: {
        count: rec("postJob", "count", (a) => {
          const json = JSON.stringify(a.where);
          const key = ["importKey", "submittedById", "reviewedByUserId", "approved", "published"].find((k) => json.includes(k));
          if (json.includes('"reviewedByUserId"')) return h.counts[json.includes('"rejected"') ? "sentBack" : "reviewed"] ?? 0;
          if (json.includes('"importKey"')) return h.counts.imported ?? 0;
          if (json.includes('"submittedById"')) return h.counts.sent ?? 0;
          if (json.includes('"approvalStatus":"approved"')) return h.counts.approved ?? 0;
          if (json.includes('"pending"')) return h.counts.scheduled ?? 0;
          void key;
          return h.counts.published ?? 0;
        }),
      },
      postJobTarget: { groupBy: rec("postJobTarget", "groupBy", () => h.targets.map((t) => ({ ...t, _count: { accountId: 1 } }))) },
      account: { findMany: rec("account", "findMany", () => h.accounts) },
      template: { count: rec("template", "count", () => h.counts.templates ?? 0) },
    },
  };
});
vi.mock("../lib/auth/index.js", () => ({
  authProvider: {
    get revokeOtherSessions() {
      return h.hasRevoke ? h.revokeOthers : undefined;
    },
  },
}));
vi.mock("../lib/auth/withAuth.js", () => ({
  withAuth: async (req: any) => {
    req.sessionId = h.sessionId;
  },
  getUser: () => ({ id: h.userId }),
  getWorkspaceId: () => "ws-1",
  getWorkspaceRole: async () => h.role,
}));

import { profileSecurityRoutes } from "./profileSecurity.js";

const NOW = new Date("2026-11-17T05:00:00Z"); // 12:00 WIB, in Q4
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const H = 3600_000;
const D = 24 * H;
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const EDGE_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, userId: "me", userAgent: CHROME_MAC, createdAt: ago(2 * H), lastActiveAt: ago(10 * 60_000), expiresAt: new Date(NOW.getTime() + 5 * D), ...patch,
});

let app: FastifyInstance;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  app = Fastify();
  await app.register(profileSecurityRoutes);
  await app.ready();
});
afterAll(async () => {
  vi.useRealTimers();
  await app.close();
});
beforeEach(() => {
  h.userId = "me";
  h.sessionId = "s-this";
  h.role = "member";
  h.sessions = [];
  h.events = [];
  h.calls = [];
  h.counts = {};
  h.targets = [];
  h.accounts = [];
  h.hasRevoke = true;
  h.revokeOthers.mockClear();
});

describe("GET /user/devices", () => {
  const get = () => app.inject({ method: "GET", url: "/user/devices" }).then((r) => r.json());

  it("lists the sessions that are open, this one marked, each with a name for the browser and the system", async () => {
    h.sessions = [session("s-this"), session("s-phone", { userAgent: EDGE_WIN, lastActiveAt: ago(40 * 60_000) })];
    const { devices } = await get();
    expect(devices).toEqual([
      expect.objectContaining({ id: "s-this", name: "Chrome on macOS", tile: "Mac", current: true }),
      expect.objectContaining({ id: "s-phone", name: "Edge on Windows", tile: "Win", current: false }),
    ]);
    expect(devices[0].lastActiveAt).toBe(ago(10 * 60_000).toISOString());
    expect(devices[0].startedAt).toBe(ago(2 * H).toISOString());
  });

  it("lists nobody else's session: the query is scoped to the signed-in person", async () => {
    h.sessions = [session("s-this"), session("s-other", { userId: "someone-else" })];
    const { devices } = await get();
    expect(devices.map((d: { id: string }) => d.id)).toEqual(["s-this"]);
    expect(h.calls.find((c) => c.model === "authSession")!.args.where.userId).toBe("me");
  });

  it("a session that has expired, or has been idle past the limit, is not a signed-in device", async () => {
    h.sessions = [session("s-this"), session("s-dead", { expiresAt: ago(H) }), session("s-idle", { lastActiveAt: ago(2 * H) })];
    expect((await get()).devices.map((d: { id: string }) => d.id)).toEqual(["s-this"]);
  });

  it("a session from before the browser was recorded is just a browser", async () => {
    h.sessions = [session("s-this", { userAgent: null })];
    expect((await get()).devices[0]).toMatchObject({ name: "Browser", tile: "Web" });
  });

  it("never sends the raw User-Agent, a token hash or an address", async () => {
    h.sessions = [session("s-this")];
    h.events = [{ id: "e1", userId: "me", at: ago(H), userAgent: CHROME_MAC, failure: null }];
    const text = JSON.stringify(await get());
    expect(text).not.toContain("Mozilla");
    expect(text).not.toContain("tokenHash");
    expect(text).not.toContain('"userAgent"');
  });

  it("recent sign-ins: the last 30 days of this person, newest first, a wrong password says so", async () => {
    h.events = [
      { id: "e1", userId: "me", at: ago(2 * D), userAgent: CHROME_MAC, failure: null },
      { id: "e2", userId: "me", at: ago(D), userAgent: EDGE_WIN, failure: "Wrong password" },
      { id: "e3", userId: "me", at: ago(31 * D), userAgent: CHROME_MAC, failure: null },
      { id: "e4", userId: "someone-else", at: ago(H), userAgent: CHROME_MAC, failure: null },
    ];
    const { signIns } = await get();
    expect(signIns).toEqual([
      { id: "e2", at: ago(D).toISOString(), device: "Edge on Windows", failure: "Wrong password" },
      { id: "e1", at: ago(2 * D).toISOString(), device: "Chrome on macOS", failure: null },
    ]);
  });

  it("nothing yet: empty lists, not an error, and how many days the history covers", async () => {
    expect(await get()).toEqual({ devices: [], days: 30, signIns: [] });
  });

  it("a flood of wrong passwords does not push the real sign-ins off the list", async () => {
    h.events = [
      { id: "real", userId: "me", at: ago(3 * D), userAgent: CHROME_MAC, failure: null },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `bad${i}`, userId: "me", at: ago(i * 60_000 + 1000), userAgent: null, failure: "Wrong password" })),
    ];
    const { signIns } = await get();
    expect(signIns.map((s: { id: string }) => s.id)).toEqual(["bad0", "bad1", "bad2", "real"]);
  });

  it("asks for the real sign-ins and the wrong passwords apart", async () => {
    await get();
    const asked = h.calls.filter((c) => c.model === "loginEvent").map((c) => [c.args.where.success, c.args.take]);
    expect(asked).toEqual([[true, 10], [false, 3]]);
  });

  it("the lists are capped: a person with many sessions and sign-ins still gets a short answer", async () => {
    h.sessions = Array.from({ length: 40 }, (_, i) => session(`s${i}`, { lastActiveAt: ago(i * 60_000 + 1000) }));
    h.events = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, userId: "me", at: ago(i * 60_000 + 1000), userAgent: null, failure: null }));
    const body = await get();
    expect(body.devices.length).toBeLessThanOrEqual(10);
    expect(body.signIns).toHaveLength(10);
  });
});

describe("DELETE /user/devices/:id", () => {
  const del = (id: string) => app.inject({ method: "DELETE", url: `/user/devices/${id}` });

  it("signs another of the person's own devices out", async () => {
    h.sessions = [session("s-this"), session("s-phone")];
    const res = await del("s-phone");
    expect(res.statusCode).toBe(200);
    expect(h.sessions.map((s) => s.id)).toEqual(["s-this"]);
  });

  it("another person's session is a 404 and is left alone: the owner is part of the filter", async () => {
    h.sessions = [session("s-this"), session("s-other", { userId: "someone-else" })];
    const res = await del("s-other");
    expect(res.statusCode).toBe(404);
    expect(h.sessions.map((s) => s.id)).toEqual(["s-this", "s-other"]);
    expect(h.calls.find((c) => c.fn === "deleteMany")!.args.where).toEqual({ id: "s-other", userId: "me" });
  });

  it("the device being used is refused: that is Log out, and nothing is deleted", async () => {
    h.sessions = [session("s-this")];
    const res = await del("s-this");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "CURRENT_DEVICE" });
    expect(h.calls.filter((c) => c.fn === "deleteMany")).toHaveLength(0);
  });

  it("a device that is already gone is a 404, not a second success", async () => {
    expect((await del("s-gone")).statusCode).toBe(404);
  });
});

describe("POST /user/devices/sign-out-others", () => {
  const post = () => app.inject({ method: "POST", url: "/user/devices/sign-out-others" });

  it("ends every session of the person except the one asking", async () => {
    expect((await post()).statusCode).toBe(200);
    expect(h.revokeOthers).toHaveBeenCalledWith("me", "s-this");
  });

  it("a sign-in method with no device list says so instead of pretending it worked", async () => {
    h.hasRevoke = false;
    const res = await post();
    expect(res.statusCode).toBe(501);
    expect(h.revokeOthers).not.toHaveBeenCalled();
  });
});

describe("GET /user/activity", () => {
  const get = () => app.inject({ method: "GET", url: "/user/activity" }).then((r) => r.json());

  it("a member sees the five numbers of their own posts, for this quarter", async () => {
    h.counts = { imported: 60, sent: 12, approved: 8, scheduled: 2, published: 1 };
    h.targets = [{ accountId: "a1" }, { accountId: "a2" }];
    h.accounts = [{ platform: "instagram" }, { platform: "instagram" }, { platform: "linkedin" }];
    const body = await get();
    expect(body).toEqual({
      quarter: "Q4 2026",
      kind: "maker",
      rows: [
        { id: "imported", count: 60 },
        { id: "sent", count: 12 },
        { id: "approved", count: 8 },
        { id: "scheduled", count: 2 },
        { id: "published", count: 1, channels: ["instagram", "linkedin"] },
      ],
    });
  });

  it("owner and admin are shown the same card as Marketing", async () => {
    for (const role of ["owner", "admin"]) {
      h.role = role;
      expect((await get()).kind, role).toBe("maker");
    }
  });

  it("the design team sees its reviews: answered, sent back, templates added", async () => {
    h.role = "designer";
    h.counts = { reviewed: 46, sentBack: 3, templates: 2 };
    expect(await get()).toEqual({
      quarter: "Q4 2026",
      kind: "reviewer",
      rows: [
        { id: "reviewed", count: 46 },
        { id: "sentBack", count: 3 },
        { id: "templates", count: 2 },
      ],
    });
  });

  it("a quarter with nothing in it is zeros, and no channels", async () => {
    const { rows } = await get();
    expect(rows.every((r: { count: number }) => r.count === 0)).toBe(true);
    expect(rows.find((r: { id: string }) => r.id === "published").channels).toEqual([]);
  });

  it("every post query is the person's own, in their workspace, and bounded by the WIB quarter", async () => {
    await get();
    const wheres = h.calls.filter((c) => c.model === "postJob" && c.fn === "count").map((c) => c.args.where);
    expect(wheres).toHaveLength(5);
    for (const w of wheres) expect(w.workspaceId).toBe("ws-1");
    for (const w of wheres) expect(w.userId === "me" || w.submittedById === "me").toBe(true);
    // Q4 2026 in WIB: 1 Oct 00:00 (30 Sep 17:00 UTC) up to 1 Jan 00:00 (31 Dec 17:00 UTC)
    const approved = wheres.find((w) => w.approvalStatus === "approved")!;
    expect(approved.reviewedAt).toEqual({ gte: new Date("2026-09-30T17:00:00Z"), lt: new Date("2026-12-31T17:00:00Z") });
  });

  it("a reviewer's numbers are their own answers, not the whole workspace's", async () => {
    h.role = "designer";
    await get();
    const wheres = h.calls.filter((c) => c.model === "postJob").map((c) => c.args.where);
    for (const w of wheres) expect(w.reviewedByUserId).toBe("me");
    expect(h.calls.find((c) => c.model === "template")!.args.where).toMatchObject({ workspaceId: "ws-1", userId: "me" });
  });

  it("the channels of what went out are read with one grouped query, not one per post", async () => {
    h.counts = { published: 30 };
    h.targets = [{ accountId: "a1" }];
    h.accounts = [{ platform: "linkedin" }];
    await get();
    expect(h.calls.filter((c) => c.model === "postJobTarget")).toHaveLength(1);
    expect(h.calls.filter((c) => c.model === "account")).toHaveLength(1);
  });
});
