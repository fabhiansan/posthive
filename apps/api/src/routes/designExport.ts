import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getWorkspaceId, getWorkspaceRole, getUser, withAuth } from "../lib/auth/withAuth.js";
import { canEditJob } from "../lib/jobEditRules.js";
import { attachUploads, mediaProblem, releaseMedia } from "../lib/mediaDelete.js";
import { toStoredUrl } from "../lib/mediaUrl.js";
import { LIMITS } from "../lib/canvas.js";
import { INSTANCE } from "../lib/canvasHttp.js";
import { designExportOf, designExportProblem, type DesignExport } from "../lib/designExport.js";
import type { StorageAdapter } from "../lib/storage.js";

const fileBody = z.object({
  format: z.enum(["png", "jpeg", "pdf"]),
  mediaUrl: z.string().min(1).max(2048),
});
const attachBody = z.object({
  instanceId: z.string().regex(LIMITS.id),
  version: z.number().int().positive(),
  files: z.array(fileBody).min(1).max(2),
});

const parseContent = (content: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(content) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * The Studio's export on a compose draft (Path A). It writes ONE content key, `canvasExport`, with an atomic
 * jsonb_set: the compose tab's caption, date and pictures are never read or rewritten here, so a Studio save and a
 * compose save cannot overwrite each other's fields. The files are ordinary uploads (claimed and locked like any
 * other media); a re-save replaces the previous export, whose files are released when nothing else uses them.
 *
 * Only a plain draft takes an export: a post in review or scheduled is a real content change away from being
 * approved, and Path A is the pre-review flow. The client hides the action there too; the server is the authority.
 */
export async function designExportRoutes(app: FastifyInstance, { storage }: { storage: StorageAdapter }): Promise<void> {
  app.post("/jobs/:id/design-export", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };
    const parsed = attachBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Send one to two generated files (png, jpeg or pdf).", code: "INVALID_DESIGN_EXPORT" });

    const job = await prisma.postJob.findFirst({
      where: { id, workspaceId },
      select: { id: true, content: true, status: true, approvalStatus: true, userId: true },
    });
    if (!job) return reply.status(404).send({ error: "Job not found" });
    const role = await getWorkspaceRole(userId, workspaceId);
    const editable = canEditJob(role, job);
    if (!editable.ok) return reply.status(editable.status).send({ error: editable.error, ...(editable.code ? { code: editable.code } : {}) });
    if (job.status !== "draft" || job.approvalStatus === "pending") {
      return reply.status(409).send({ error: "A Studio design can only be attached to a plain draft. Send the post back to Draft first.", code: "NOT_A_DRAFT" });
    }

    const { instanceId, version } = parsed.data;
    const instance = await prisma.design.findFirst({
      where: { id: instanceId, workspaceId, kind: INSTANCE, createdByUserId: userId },
      select: { version: true },
    });
    if (!instance) return reply.status(404).send({ error: "Design not found" });
    if (instance.version !== version) {
      return reply.status(409).send({ error: "The design changed since it was exported. Save it again.", code: "VERSION_CONFLICT" });
    }

    const files = parsed.data.files.map((f) => ({ format: f.format, mediaUrl: toStoredUrl(f.mediaUrl) }));
    const problem = designExportProblem(files);
    if (problem) return reply.status(400).send({ error: problem, code: "INVALID_DESIGN_EXPORT" });

    const value: DesignExport = { instanceId, version, files };
    const previous = designExportOf(parseContent(job.content).canvasExport);
    const urls = files.map((f) => f.mediaUrl);

    try {
      await prisma.$transaction(
        async (tx) => {
          // Two Studio saves for one post are serialized (Postgres only, like the other advisory locks in the app).
          if (!process.env.DATABASE_URL?.startsWith("file:")) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
          }
          await attachUploads(tx, urls, { userId });
          await tx.$executeRaw`
            UPDATE "PostJob"
            SET "content" = jsonb_set("content"::jsonb, '{canvasExport}'::text[], ${JSON.stringify(value)}::jsonb, true)::text,
                "updatedAt" = NOW()
            WHERE "id" = ${id} AND "workspaceId" = ${workspaceId}`;
        },
        { timeout: 30_000 },
      );
    } catch (err) {
      const media = mediaProblem(err);
      if (media) return reply.status(media.status).send(media.body);
      throw err;
    }

    const dropped = (previous?.files.map((f) => f.mediaUrl) ?? []).filter((url) => !urls.includes(url));
    if (dropped.length > 0) {
      try {
        await releaseMedia(storage, dropped, [job.userId, userId]);
      } catch (err) {
        req.log.warn({ err }, "the previous design export was not cleaned up");
      }
    }
    return reply.status(201).send({ canvasExport: value });
  });

  app.delete("/jobs/:id/design-export", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const job = await prisma.postJob.findFirst({
      where: { id, workspaceId },
      select: { id: true, content: true, status: true, approvalStatus: true, userId: true },
    });
    if (!job) return reply.status(404).send({ error: "Job not found" });
    const role = await getWorkspaceRole(userId, workspaceId);
    const editable = canEditJob(role, job);
    if (!editable.ok) return reply.status(editable.status).send({ error: editable.error, ...(editable.code ? { code: editable.code } : {}) });
    if (job.status !== "draft" || job.approvalStatus === "pending") {
      return reply.status(409).send({ error: "A Studio design can only be removed from a plain draft. Send the post back to Draft first.", code: "NOT_A_DRAFT" });
    }

    const previous = designExportOf(parseContent(job.content).canvasExport);
    await prisma.$transaction(async (tx) => {
      if (!process.env.DATABASE_URL?.startsWith("file:")) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      }
      await tx.$executeRaw`
        UPDATE "PostJob"
        SET "content" = ("content"::jsonb - 'canvasExport')::text,
            "updatedAt" = NOW()
        WHERE "id" = ${id} AND "workspaceId" = ${workspaceId}`;
    });

    if (previous) {
      try {
        await releaseMedia(storage, previous.files.map((f) => f.mediaUrl), [job.userId, userId]);
      } catch (err) {
        req.log.warn({ err }, "the removed design export was not cleaned up");
      }
    }
    return reply.send({ ok: true });
  });
}
