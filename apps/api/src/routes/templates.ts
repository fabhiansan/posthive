import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { withAuth, withAuthOrToken, getUser, getWorkspaceId, requireTemplateManagerRole } from "../lib/auth/withAuth.js";
import { CATEGORIES, PILLARS, pillarFor } from "../lib/contentTypes.js";
import { safeFileName, type StorageAdapter } from "../lib/storage.js";
import { TEMPLATE_FILE_MAX_BYTES, TEMPLATE_SELECT, isFigFile, withoutTemplateMedia } from "../lib/templates.js";

const urlPath = (url: string) => { try { return new URL(url, "http://x").pathname; } catch { return ""; } };

// Design template (docs/content-types.md): the reference design for one content type
// (Pillar + Category) — an editable .fig file and/or a link, plus an optional preview.
// One per workspace and category. Posts only take the pillar/category, never the files.
const templateBody = z.object({
  pillar: z.enum(PILLARS).nullable(),
  category: z.enum(CATEGORIES),
  fileUrl: z.string().trim().min(1).max(2048).nullable().default(null),
  fileName: z.string().trim().min(1).max(200).nullable().default(null),
  fileSize: z.number().int().min(1).max(TEMPLATE_FILE_MAX_BYTES).nullable().default(null),
  linkUrl: z.string().trim().max(2048).url("Enter a valid link").nullable().default(null),
  previewUrl: z.string().trim().min(1).max(2048).nullable().default(null),
}).superRefine((t, ctx) => {
  if (t.pillar !== pillarFor(t.category)) {
    const expected = pillarFor(t.category) ?? "no pillar";
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pillar"], message: `${t.category} belongs to ${expected}` });
  }
  if (!t.fileUrl && !t.linkUrl) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fileUrl"], message: "Add a design file (.fig) or a link" });
  }
  if (t.linkUrl && !t.linkUrl.toLowerCase().startsWith("https://")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["linkUrl"], message: "The link must start with https://" });
  }
  if (t.fileUrl && !/\.fig$/i.test(urlPath(t.fileUrl))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fileUrl"], message: "The design file must be a .fig file" });
  }
  if (t.fileUrl && (!t.fileName || !/\.fig$/i.test(t.fileName) || /[\\/]/.test(t.fileName))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fileName"], message: "The design file needs a .fig file name" });
  }
  if (t.previewUrl && !/\.(jpe?g|png|gif|webp)$/i.test(urlPath(t.previewUrl))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["previewUrl"], message: "The preview must be an image" });
  }
});

type TemplateBody = z.infer<typeof templateBody>;

function templateData(t: TemplateBody) {
  return {
    name: t.category,
    category: t.category,
    // Pillar is derived, never trusted from the client
    pillar: pillarFor(t.category),
    fileUrl: t.fileUrl,
    fileName: t.fileUrl ? t.fileName : null,
    fileSize: t.fileUrl ? t.fileSize : null,
    linkUrl: t.linkUrl,
    previewUrl: t.previewUrl,
  };
}

const filesOf = (t: { fileUrl: string | null; previewUrl: string | null }) =>
  [t.fileUrl, t.previewUrl].filter((u): u is string => !!u);

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

const duplicate = (category: string) => ({ error: `A template for ${category} already exists. Edit that template instead.` });

export async function templateRoutes(
  app: FastifyInstance,
  { storage }: { storage: StorageAdapter },
): Promise<void> {

  // Files the caller just uploaded may be attached; anything else (another user's or
  // another workspace's file) may not — deleting the template would delete that file.
  async function ownsUploads(urls: string[], userId: string): Promise<boolean> {
    if (!urls.length) return true;
    const owned = await prisma.upload.count({ where: { url: { in: urls }, userId } });
    return owned === new Set(urls).size;
  }

  // Uploads unclaimed for 24h are deleted by the orphan cron (index.ts) — claim template files.
  async function claimUploads(urls: string[]): Promise<void> {
    if (urls.length) await prisma.upload.updateMany({ where: { url: { in: urls } }, data: { claimedAt: new Date() } });
  }

  // Remove files a template no longer uses. Legacy kit files stay (posts share them).
  async function removeFiles(urls: string[]): Promise<void> {
    const free = await withoutTemplateMedia(urls);
    if (!free.length) return;
    await Promise.allSettled(free.map((url) => storage.delete(url)));
    await prisma.upload.deleteMany({ where: { url: { in: free } } });
  }

  // List the workspace's design templates (every role can view). Rows without a
  // category are legacy caption templates, removed by the cleanup migration.
  app.get("/templates", { preHandler: [withAuthOrToken] }, async (req, reply) => {
    const workspaceId = getWorkspaceId(req);
    const templates = await prisma.template.findMany({
      where: { workspaceId, category: { not: null } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: TEMPLATE_SELECT,
    });
    return reply.send({ templates });
  });

  // Upload the editable design file (.fig) — design team only
  app.post("/templates/file", { preHandler: [withAuth], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);

    const forbidden = await requireTemplateManagerRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const data = await req.file({ limits: { fileSize: TEMPLATE_FILE_MAX_BYTES } });
    if (!data) return reply.status(400).send({ error: "No file uploaded — send as multipart field 'file'" });

    let buf: Buffer;
    try {
      buf = await data.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.status(413).send({ error: `File too large. The maximum is ${TEMPLATE_FILE_MAX_BYTES / 1024 / 1024} MB.` });
      }
      throw err;
    }

    const original = (data.filename ?? "").split(/[\\/]/).pop() ?? "";
    const fileName = original.length <= 200 ? original : safeFileName(original);
    if (!isFigFile(fileName, buf)) {
      return reply.status(400).send({ error: "Upload a Figma design file (.fig). In Figma use File → Save local copy." });
    }

    let url: string;
    try {
      url = await storage.upload(buf, "application/x-figma", "template-files", fileName);
    } catch (err) {
      req.log.error({ err }, "[templates] design file upload failed");
      return reply.status(502).send({ error: "Could not store the design file. Try again." });
    }
    await prisma.upload.create({ data: { url, userId } });
    return reply.status(201).send({ url, fileName, fileSize: buf.length });
  });

  // Create a template — design team only (docs/role-access-matrix.md US-07)
  app.post("/templates", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);

    const forbidden = await requireTemplateManagerRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const parsed = templateBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid template" });
    const body = parsed.data;

    const existing = await prisma.template.findFirst({ where: { workspaceId, category: body.category }, select: { id: true } });
    if (existing) return reply.status(409).send(duplicate(body.category));

    const files = filesOf(body);
    if (!(await ownsUploads(files, userId))) return reply.status(400).send({ error: "Upload the design file and preview again." });

    try {
      const template = await prisma.template.create({
        data: { userId, workspaceId, ...templateData(body) },
        select: TEMPLATE_SELECT,
      });
      await claimUploads(files);
      return reply.status(201).send({ template });
    } catch (err) {
      if (isUniqueViolation(err)) return reply.status(409).send(duplicate(body.category));
      throw err;
    }
  });

  // Replace a template (content type, file, link, preview) — design team only
  app.patch("/templates/:id", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const forbidden = await requireTemplateManagerRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const parsed = templateBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid template" });
    const body = parsed.data;

    const current = await prisma.template.findFirst({
      where: { id, workspaceId },
      select: { id: true, category: true, fileUrl: true, previewUrl: true },
    });
    if (!current) return reply.status(404).send({ error: "Not found" });

    // Only a category change can create a duplicate (legacy duplicates are cleaned up separately)
    if (body.category !== current.category) {
      const clash = await prisma.template.findFirst({
        where: { workspaceId, category: body.category, id: { not: id } },
        select: { id: true },
      });
      if (clash) return reply.status(409).send(duplicate(body.category));
    }

    const kept = new Set(filesOf(current));
    const added = filesOf(body).filter((url) => !kept.has(url));
    if (!(await ownsUploads(added, userId))) return reply.status(400).send({ error: "Upload the design file and preview again." });

    let template;
    try {
      template = await prisma.template.update({ where: { id }, data: templateData(body), select: TEMPLATE_SELECT });
    } catch (err) {
      if (isUniqueViolation(err)) return reply.status(409).send(duplicate(body.category));
      throw err;
    }
    await claimUploads(added);
    const next = new Set(filesOf(body));
    await removeFiles(filesOf(current).filter((url) => !next.has(url)));
    return reply.send({ template });
  });

  // Delete a template and its files — design team only. Posts never reference
  // design template files; legacy kit files stay protected (withoutTemplateMedia).
  app.delete("/templates/:id", { preHandler: [withAuth] }, async (req, reply) => {
    const { id: userId } = getUser(req);
    const workspaceId = getWorkspaceId(req);
    const { id } = req.params as { id: string };

    const forbidden = await requireTemplateManagerRole(userId, workspaceId);
    if (forbidden) return reply.status(403).send(forbidden);

    const template = await prisma.template.findFirst({
      where: { id, workspaceId },
      select: { id: true, fileUrl: true, previewUrl: true },
    });
    if (!template) return reply.status(404).send({ error: "Not found" });

    await prisma.template.delete({ where: { id } });
    await removeFiles(filesOf(template));
    return reply.send({ ok: true });
  });
}
