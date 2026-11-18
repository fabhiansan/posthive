// What the profile page asks about the signed-in person: the devices their account is open on, their recent
// sign-ins, and their activity of the quarter. Every query is scoped to `userId` from the session, never to an id
// the browser sends, so nobody reads or ends anybody else's session.
import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { authProvider } from "../lib/auth/index.js";
import { getUser, getWorkspaceId, getWorkspaceRole, withAuth } from "../lib/auth/withAuth.js";
import { sessionState } from "../lib/auth/sessionPolicy.js";
import { deviceOf } from "../lib/deviceLabel.js";
import { LOGIN_HISTORY_DAYS } from "../lib/loginHistory.js";
import { isReviewerOnly, makerWhere, quarterRange, reviewerWhere, type ActivityRow, type UserActivity } from "../lib/userActivity.js";

/** Rows each list answers with: a person has a handful of devices, and the page shows the latest sign-ins. */
const DEVICES_LIMIT = 10;
const SIGN_INS_LIMIT = 10;
/** The wrong passwords that go with them: a few, so a flood of guesses cannot push the real sign-ins off the list. */
const FAILED_LIMIT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function profileSecurityRoutes(app: FastifyInstance): Promise<void> {
  // The sessions that are open now (this one marked), and the last sign-ins and wrong passwords.
  app.get("/user/devices", { preHandler: [withAuth], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const now = new Date();
    const since = new Date(now.getTime() - LOGIN_HISTORY_DAYS * DAY_MS);

    const history = (success: boolean, take: number) =>
      prisma.loginEvent.findMany({
        where: { userId, at: { gte: since }, success },
        orderBy: [{ at: "desc" }, { id: "asc" }],
        take,
        select: { id: true, at: true, userAgent: true, failure: true },
      });

    const [sessions, signedIn, wrongPassword] = await Promise.all([
      // an expired session is only waiting for the cleanup: it is not a device that is signed in
      prisma.authSession.findMany({
        where: { userId, expiresAt: { gt: now } },
        orderBy: [{ lastActiveAt: "desc" }, { id: "asc" }],
        take: DEVICES_LIMIT * 2,
        select: { id: true, userAgent: true, createdAt: true, lastActiveAt: true, expiresAt: true },
      }),
      // asked apart: someone who keeps guessing at the password would otherwise fill the list and hide every real sign-in
      history(true, SIGN_INS_LIMIT),
      history(false, FAILED_LIMIT),
    ]);
    const events = [...signedIn, ...wrongPassword].sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));

    const devices = sessions
      .filter((s) => sessionState(s, now) === "active")
      .slice(0, DEVICES_LIMIT)
      .map((s) => ({
        id: s.id,
        ...deviceOf(s.userAgent),
        startedAt: s.createdAt.toISOString(),
        lastActiveAt: s.lastActiveAt.toISOString(),
        current: s.id === req.sessionId,
      }));

    return reply.send({
      devices,
      days: LOGIN_HISTORY_DAYS,
      signIns: events.map((e) => ({ id: e.id, at: e.at.toISOString(), device: deviceOf(e.userAgent).name, failure: e.failure })),
    });
  });

  // Sign one other device out. The session must be this person's own, and not the one asking: that is Log out.
  app.delete("/user/devices/:id", { preHandler: [withAuth], config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const { id } = req.params as { id: string };
    if (id === req.sessionId) return reply.status(400).send({ error: "This is the device you are using. Log out instead.", code: "CURRENT_DEVICE" });

    // the owner is part of the filter, so another person's session id is a plain 404, not a hint that it exists
    const { count } = await prisma.authSession.deleteMany({ where: { id, userId } });
    if (count === 0) return reply.status(404).send({ error: "That device is not signed in any more.", code: "NOT_FOUND" });
    return reply.send({ ok: true });
  });

  // Sign every device out except this one.
  app.post("/user/devices/sign-out-others", { preHandler: [withAuth], config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    if (!authProvider.revokeOtherSessions) return reply.status(501).send({ error: "This sign-in method has no device list.", code: "UNSUPPORTED" });
    await authProvider.revokeOtherSessions(userId, req.sessionId);
    return reply.send({ ok: true });
  });

  // "Your activity": the person's own numbers for this quarter, in the workspace they are in.
  app.get("/user/activity", { preHandler: [withAuth], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const role = await getWorkspaceRole(userId, workspaceId);
    const range = quarterRange(new Date());

    if (isReviewerOnly(role)) {
      const w = reviewerWhere(workspaceId, userId, range);
      const [reviewed, sentBack, templates] = await Promise.all([prisma.postJob.count({ where: w.reviewed }), prisma.postJob.count({ where: w.sentBack }), prisma.template.count({ where: w.templates })]);
      const rows: ActivityRow[] = [
        { id: "reviewed", count: reviewed },
        { id: "sentBack", count: sentBack },
        { id: "templates", count: templates },
      ];
      return reply.send({ quarter: range.label, kind: "reviewer", rows } satisfies UserActivity);
    }

    const w = makerWhere(workspaceId, userId, range);
    const [imported, sent, approved, scheduled, published, publishedTargets] = await Promise.all([
      prisma.postJob.count({ where: w.imported }),
      prisma.postJob.count({ where: w.sent }),
      prisma.postJob.count({ where: w.approved }),
      prisma.postJob.count({ where: w.scheduled }),
      prisma.postJob.count({ where: w.published }),
      // which channels the published posts went to: one grouped read of their targets, not a post at a time
      prisma.postJobTarget.groupBy({ by: ["accountId"], where: { postJob: w.published }, _count: { accountId: true } }),
    ]);
    const accounts = publishedTargets.length
      ? await prisma.account.findMany({ where: { id: { in: publishedTargets.map((t) => t.accountId) }, workspaceId }, select: { platform: true } })
      : [];
    const channels = [...new Set(accounts.map((a) => a.platform))];

    const rows: ActivityRow[] = [
      { id: "imported", count: imported },
      { id: "sent", count: sent },
      { id: "approved", count: approved },
      { id: "scheduled", count: scheduled },
      { id: "published", count: published, channels },
    ];
    return reply.send({ quarter: range.label, kind: "maker", rows } satisfies UserActivity);
  });
}
