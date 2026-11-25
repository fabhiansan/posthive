import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getUser, getWorkspaceId, getWorkspaceRole, withAuth } from "../lib/auth/withAuth.js";
import { contentOf, titleOf } from "../lib/dashboardData.js";
import {
  NOTE_MAX,
  TASK_PAGE_SIZE,
  TASK_SELECT,
  countTasks,
  isTaskTab,
  taskBase,
  taskOrder,
  taskTabWhere,
  toTaskDetail,
  toTaskItem,
} from "../lib/designTasks.js";
import { checkFigmaLink } from "../lib/figmaCheck.js";
import { isFigmaDesignUrl } from "../lib/figmaLink.js";
import { sendDesignDoneEmail } from "../lib/mailer.js";
import { notify } from "../lib/notifications.js";

const FORBIDDEN = { error: "My Task is for the design team.", code: "FORBIDDEN" } as const;
const NOT_FOUND = { error: "Task not found", code: "NOT_FOUND" } as const;
const TASK_DONE = { error: "This design was already sent to Marketing.", code: "TASK_DONE" } as const;

/** "" and null clear the saved link; anything else is a Figma file, design, prototype or board link. */
const maybeFigma = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .refine((v) => !v || isFigmaDesignUrl(v), "Use a Figma link, like https://www.figma.com/design/…");
const note = z.string().trim().max(NOTE_MAX).nullish();

export async function designTaskRoutes(app: FastifyInstance): Promise<void> {
  // Everything here is the design team's, and only for the tasks sent to the person asking: every query below carries
  // `assigneeId: me`, so a task of another designer is a 404, not a 403 (it does not say the post exists). This does NOT
  // widen isDraftVisibleTo: the post is read through the task, and only as the fields of lib/designTasks.ts.
  async function designerOnly(req: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    if ((await getWorkspaceRole(userId, workspaceId)) !== "designer") {
      reply.status(403).send(FORBIDDEN);
      return null;
    }
    return { userId, workspaceId };
  }

  // One page of one tab of My Task, with the counts of the cards. Soonest deadline first (none last), the Done tab newest first.
  app.get("/design-tasks", { preHandler: [withAuth], config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const who = await designerOnly(req, reply);
    if (!who) return;
    const query = req.query as { tab?: string; page?: string };
    const tab = isTaskTab(query.tab) ? query.tab : "all";

    const counts = await countTasks(prisma, who.workspaceId, who.userId);
    const total = { all: counts.assigned + counts.progress + counts.done, assigned: counts.assigned, progress: counts.progress, done: counts.done }[tab];
    const pageCount = Math.max(1, Math.ceil(total / TASK_PAGE_SIZE));
    // a page past the end answers the last one
    const page = Math.min(Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1), pageCount);

    const rows = await prisma.designRequest.findMany({
      where: { ...taskBase(who.workspaceId, who.userId), ...taskTabWhere(tab) },
      orderBy: taskOrder(tab),
      skip: (page - 1) * TASK_PAGE_SIZE,
      take: TASK_PAGE_SIZE,
      select: TASK_SELECT,
    });
    return reply.send({ counts, tab, total, page, pageCount, pageSize: TASK_PAGE_SIZE, items: rows.map(toTaskItem) });
  });

  // One task: what Marketing wrote about the post and the design, and the designer's own saved link and note.
  app.get("/design-tasks/:postId", { preHandler: [withAuth], config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const who = await designerOnly(req, reply);
    if (!who) return;
    const { postId } = req.params as { postId: string };
    const row = await prisma.designRequest.findFirst({
      where: { ...taskBase(who.workspaceId, who.userId), postJobId: postId, status: { in: ["sent", "done"] } },
      select: TASK_SELECT,
    });
    if (!row) return reply.status(404).send(NOT_FOUND);
    return reply.send({ task: toTaskDetail(row) });
  });

  // "Is this link something Marketing can open?" for the line under the field. Figma's own answer, never saved.
  app.post("/design-tasks/check-link", { preHandler: [withAuth], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const who = await designerOnly(req, reply);
    if (!who) return;
    const body = z.object({ url: z.string().trim().max(500) }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "url is required", code: "VALIDATION" });
    return reply.send(await checkFigmaLink(body.data.url));
  });

  // Save draft: the designer's own link and note. Marketing sees nothing until Mark as done. Only while the task is open.
  app.put(
    "/design-tasks/:postId/draft",
    { preHandler: [withAuth], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const who = await designerOnly(req, reply);
      if (!who) return;
      const { postId } = req.params as { postId: string };
      const parsed = z.object({ figmaUrl: maybeFigma, note }).safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Use a Figma link, like https://www.figma.com/design/… and a note of at most 2000 characters.", code: "VALIDATION" });

      const data = { figmaUrl: parsed.data.figmaUrl || null, designerNote: parsed.data.note || null };
      // the write itself refuses a task that is not open and mine, so a Mark as done at the same moment cannot be overwritten
      const { count } = await prisma.designRequest.updateMany({
        where: { ...taskBase(who.workspaceId, who.userId), postJobId: postId, status: "sent" },
        data,
      });
      if (count === 0) {
        const exists = await prisma.designRequest.findFirst({ where: { ...taskBase(who.workspaceId, who.userId), postJobId: postId, status: "done" }, select: { id: true } });
        return exists ? reply.status(409).send(TASK_DONE) : reply.status(404).send(NOT_FOUND);
      }
      return reply.send({ ok: true });
    },
  );

  // Mark as done: the link is checked again (a pasted link can change between the check and the click), the task is locked,
  // the link becomes the post's design link, and Marketing is told.
  app.post(
    "/design-tasks/:postId/done",
    { preHandler: [withAuth], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const who = await designerOnly(req, reply);
      if (!who) return;
      const { postId } = req.params as { postId: string };
      const parsed = z.object({ figmaUrl: z.string().trim().min(1).max(500), note }).safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Add the Figma link to your design.", code: "FIGMA_FORMAT" });

      const check = await checkFigmaLink(parsed.data.figmaUrl);
      if (check.state === "format") return reply.status(400).send({ error: "Use a Figma link, like https://www.figma.com/design/… (file, design, proto or board).", code: "FIGMA_FORMAT" });
      if (check.state === "private") {
        return reply.status(422).send({ error: "Figma can't open this link. Set sharing to \"Anyone with the link can view\", then try again.", code: "FIGMA_PRIVATE" });
      }

      const task = await prisma.designRequest.findFirst({
        where: { ...taskBase(who.workspaceId, who.userId), postJobId: postId, status: { in: ["sent", "done"] } },
        select: { status: true, createdById: true, postJob: { select: { id: true, content: true, userId: true } } },
      });
      if (!task) return reply.status(404).send(NOT_FOUND);
      if (task.status === "done") return reply.status(409).send(TASK_DONE);

      const figmaUrl = parsed.data.figmaUrl;
      const answered = await prisma.$transaction(async (tx) => {
        const { count } = await tx.designRequest.updateMany({
          where: { ...taskBase(who.workspaceId, who.userId), postJobId: postId, status: "sent" },
          data: { status: "done", doneAt: new Date(), figmaUrl, designerNote: parsed.data.note || null },
        });
        if (count === 0) return false;
        // shortcut: read-modify-write of the content JSON; a Marketing PATCH in the same instant can win and lose this key. The link
        // is still on the request, so nothing is lost: upgrade to a JSON merge in SQL if it ever matters.
        await tx.postJob.update({ where: { id: postId }, data: { content: JSON.stringify({ ...contentOf(task.postJob.content), designFigmaUrl: figmaUrl }) } });
        return true;
      });
      if (!answered) return reply.status(409).send(TASK_DONE);

      // Marketing: the person who sent the request, else the post's author
      const recipientId = task.createdById ?? task.postJob.userId;
      const title = titleOf(contentOf(task.postJob.content));
      await notify([{ workspaceId: who.workspaceId, userId: recipientId, kind: "design_done", postJobId: postId, actorId: who.userId }]);
      void sendDoneEmail(recipientId, who.userId, { postId, title, note: parsed.data.note || null });

      return reply.send({ ok: true, title: check.state === "valid" ? check.title : null, checked: check.state === "valid" });
    },
  );
}

/** Fire and forget: an e-mail that cannot be sent never undoes the design. */
async function sendDoneEmail(recipientId: string, designerId: string, a: { postId: string; title: string; note: string | null }): Promise<void> {
  try {
    const [to, designer] = await Promise.all([
      prisma.user.findUnique({ where: { id: recipientId }, select: { email: true } }),
      prisma.user.findUnique({ where: { id: designerId }, select: { name: true } }),
    ]);
    if (!to?.email) return;
    await sendDesignDoneEmail(to.email, { postTitle: a.title, designerName: designer?.name ?? "A designer", postId: a.postId, note: a.note });
  } catch (err) {
    console.warn(`[design-tasks] could not send the done e-mail for ${a.postId}:`, (err as Error).message);
  }
}
