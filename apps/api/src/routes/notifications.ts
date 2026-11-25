import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getUser, getWorkspaceId, withAuth } from "../lib/auth/withAuth.js";
import { NOTIFICATION_LIMIT, toNotificationView } from "../lib/notifications.js";

// The bell and the drawer of every role. Each person reads only their own rows of the workspace they are in, so there is no
// role check: what a role is told is decided where the row is written (lib/notifications.ts and the routes that call it).
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const mine = (req: Parameters<typeof getUser>[0]) => ({ userId: getUser(req).id, workspaceId: getWorkspaceId(req) });

  // The drawer: the latest rows, newest first, and how many are unread in all (not only among these).
  app.get("/notifications", { preHandler: [withAuth], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const where = mine(req);
    const [rows, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: NOTIFICATION_LIMIT,
        select: { id: true, kind: true, postJobId: true, readAt: true, createdAt: true, actor: { select: { name: true } }, postJob: { select: { content: true, reviewNote: true } } },
      }),
      prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);
    return reply.send({ items: rows.map(toNotificationView), unread });
  });

  // The badge on the bell: asked every minute, so it is one count on the (user, workspace, readAt) index.
  app.get("/notifications/unread-count", { preHandler: [withAuth], config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    return reply.send({ unread: await prisma.notification.count({ where: { ...mine(req), readAt: null } }) });
  });

  app.post("/notifications/read-all", { preHandler: [withAuth], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { count } = await prisma.notification.updateMany({ where: { ...mine(req), readAt: null }, data: { readAt: new Date() } });
    return reply.send({ marked: count });
  });

  // Another person's row, or one that is already read, answers the same: nothing to do.
  app.post("/notifications/:id/read", { preHandler: [withAuth], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: "Invalid id", code: "VALIDATION" });
    const { count } = await prisma.notification.updateMany({ where: { ...mine(req), id: params.data.id, readAt: null }, data: { readAt: new Date() } });
    return reply.send({ marked: count });
  });
}
