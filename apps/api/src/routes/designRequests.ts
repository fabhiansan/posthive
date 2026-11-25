import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  CONTENT_EDITOR_FORBIDDEN,
  getUser,
  getWorkspaceId,
  getWorkspaceRole,
  isContentEditorRole,
  isDraftVisibleTo,
  withAuth,
} from "../lib/auth/withAuth.js";
import { safeLink } from "../lib/contentList.js";
import { realDate } from "../lib/dashboardData.js";
import { DEADLINE_MESSAGE, deadlineProblem, designRequestSelect, toDesignRequestView } from "../lib/designRequest.js";
import { notify } from "../lib/notifications.js";

const DESIGNERS_MAX = 100;

const requestBody = z.object({
  assigneeId: z.string().cuid(),
  // optional; an instant (ISO, like scheduledFor). The editor works it out from a WIB date and time. null / absent: no deadline
  deadline: z.string().datetime().nullish(),
  brief: z.string().trim().min(1).max(5000),
  referenceUrl: z.string().trim().max(500).nullish(),
  send: z.boolean().default(false),
});

export async function designRequestRoutes(app: FastifyInstance): Promise<void> {
  // The designers of the workspace, for the "Designer (PIC)" select. Marketing cannot list members (that route is
  // owner/admin only), so this answers only what the select needs: no e-mail addresses.
  app.get("/design-requests/designers", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    if (!isContentEditorRole(await getWorkspaceRole(userId, workspaceId))) {
      return reply.status(403).send(CONTENT_EDITOR_FORBIDDEN);
    }
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId, role: "designer" },
      orderBy: { user: { name: "asc" } },
      take: DESIGNERS_MAX,
      select: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });
    return reply.send({ designers: members.map((m) => m.user) });
  });

  // Save the brief (send: false) or send the request to the designer (send: true). A sent request is locked: it
  // changes again only after Marketing cancels it. Only a plain draft can have one: a post in review, scheduled or
  // published has nothing left to design.
  app.put(
    "/jobs/:id/design-request",
    { preHandler: [withAuth], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id: userId } = getUser(req);
      const workspaceId = getWorkspaceId(req);
      const { id } = req.params as { id: string };

      const role = await getWorkspaceRole(userId, workspaceId);
      if (!isContentEditorRole(role)) return reply.status(403).send(CONTENT_EDITOR_FORBIDDEN);

      const parsed = requestBody.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { assigneeId, brief, send } = parsed.data;
      const due = parsed.data.deadline ? new Date(parsed.data.deadline) : null;
      const referenceUrl = parsed.data.referenceUrl ? safeLink(parsed.data.referenceUrl) : null;
      if (parsed.data.referenceUrl && !referenceUrl) {
        return reply.status(400).send({ error: "The reference link must be a web address (http or https).", code: "INVALID_LINK" });
      }

      const job = await prisma.postJob.findFirst({
        where: { id, workspaceId },
        select: { status: true, approvalStatus: true, scheduledFor: true, userId: true, designRequest: { select: { status: true } } },
      });
      if (!job || !isDraftVisibleTo(role, userId, job)) return reply.status(404).send({ error: "Job not found" });
      if (job.status !== "draft") {
        return reply.status(409).send({ error: "Only a draft can be sent to a designer.", code: "NOT_DRAFT" });
      }
      if (job.approvalStatus === "pending") {
        return reply.status(409).send({ error: "This post is in review. A design request is for a draft.", code: "IN_REVIEW" });
      }
      if (job.designRequest?.status === "sent") {
        return reply.status(409).send({ error: "The request is already with the designer. Cancel it to change it.", code: "REQUEST_SENT" });
      }
      if (job.designRequest?.status === "done") {
        return reply.status(409).send({ error: "The designer already sent the design for this post.", code: "REQUEST_DONE" });
      }

      const designer = await prisma.workspaceMember.findFirst({
        where: { workspaceId, userId: assigneeId, role: "designer" },
        select: { id: true },
      });
      if (!designer) return reply.status(400).send({ error: "Pick a designer from this workspace.", code: "INVALID_DESIGNER" });

      // A saved brief may have no deadline; a sent request needs one. A post made by the API with no date holds the epoch:
      // that is no publishing time to check against
      const problem = due ? deadlineProblem(due, new Date(), realDate(job.scheduledFor)) : send ? "DEADLINE_REQUIRED" : null;
      if (problem) return reply.status(400).send({ error: DEADLINE_MESSAGE[problem], code: problem });

      const data = {
        assigneeId,
        deadline: due, // a full replace: null clears a deadline that was set before
        brief,
        referenceUrl,
        status: send ? "sent" : "draft",
        sentAt: send ? new Date() : null,
      };
      const select = designRequestSelect(workspaceId);
      // shortcut: a post sent for review in the same instant as this send slips past the checks above; the submit's own
      // WHERE (NOT_IN_DESIGN) closes the other order. Upgrade to one transaction when requests drive a real queue.
      const taken = { error: "The request is already with the designer. Cancel it to change it.", code: "REQUEST_SENT" };
      let saved;
      if (job.designRequest) {
        const { count } = await prisma.designRequest.updateMany({
          where: { postJobId: id, workspaceId, status: "draft" },
          data,
        });
        if (count === 0) return reply.status(409).send(taken);
        saved = await prisma.designRequest.findUnique({ where: { postJobId: id }, select });
      } else {
        try {
          saved = await prisma.designRequest.create({
            data: { ...data, workspaceId, postJobId: id, createdById: userId },
            select,
          });
        } catch (err) {
          if ((err as { code?: string }).code === "P2002") return reply.status(409).send(taken);
          throw err;
        }
      }
      // the designer hears about a new task; a saved brief is nobody's task yet
      if (send) await notify([{ workspaceId, userId: assigneeId, kind: "task_assigned", postJobId: id, actorId: userId }]);
      return reply.send({ request: saved ? toDesignRequestView(saved) : null });
    },
  );

  // Take a sent request back: the brief stays, the lock goes, and Marketing can change it or send it to someone else.
  app.post(
    "/jobs/:id/design-request/cancel",
    { preHandler: [withAuth], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id: userId } = getUser(req);
      const workspaceId = getWorkspaceId(req);
      const { id } = req.params as { id: string };

      const role = await getWorkspaceRole(userId, workspaceId);
      if (!isContentEditorRole(role)) return reply.status(403).send(CONTENT_EDITOR_FORBIDDEN);

      const job = await prisma.postJob.findFirst({
        where: { id, workspaceId },
        select: { status: true, approvalStatus: true, userId: true },
      });
      if (!job || !isDraftVisibleTo(role, userId, job)) return reply.status(404).send({ error: "Job not found" });

      // who the task was with, read before the answer clears it: a designer's saved link and note go with the request
      const was = await prisma.designRequest.findUnique({ where: { postJobId: id }, select: { assigneeId: true } });
      const { count } = await prisma.designRequest.updateMany({
        where: { postJobId: id, workspaceId, status: "sent" },
        data: { status: "draft", sentAt: null, figmaUrl: null, designerNote: null },
      });
      if (count === 0) return reply.status(409).send({ error: "There is no sent request to cancel.", code: "NOT_SENT" });
      await notify([{ workspaceId, userId: was?.assigneeId, kind: "task_cancelled", postJobId: id, actorId: userId }]);

      const saved = await prisma.designRequest.findUnique({ where: { postJobId: id }, select: designRequestSelect(workspaceId) });
      return reply.send({ request: saved ? toDesignRequestView(saved) : null });
    },
  );
}
